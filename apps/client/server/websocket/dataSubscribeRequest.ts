import { GoneException } from '@aws-sdk/client-apigatewaymanagementapi';
import { DataSubscribeRequestAction, InviteType, Permission } from '@bike4mind/common';
import {
  AdminSettings,
  ApiKey,
  AppFile,
  Artifact,
  ArtifactVersion,
  FabFile,
  findModelByCollectionName,
  Inbox,
  Invite,
  mongoose,
  Organization,
  Project,
  QuerySubscription,
  Quest,
  QuestMasterPlan,
  User,
} from '@bike4mind/database';
import { Session as SessionModel } from '@bike4mind/database/auth';
import { accessibleBy } from '@casl/mongoose';
import { Subscription } from '@server/models/Subscription';
import { questMasterPlanSubscriptionScope } from '@server/websocket/subscriptionScopes';
import { NotFoundError } from '@server/utils/errors';
import { sendToConnection, withWebSocketContext } from '@server/websocket/utils';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { pickBy } from 'lodash';
import pLimit from 'p-limit';
import ability from '../auth/ability';
import { secretRotationRepository } from '@bike4mind/database/infra';
import { dayjs } from '@bike4mind/common';
import { authTokenGenerator } from '@server/auth/tokenGenerator';
import { APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';
import { Resource } from 'sst';

const HARD_LIMIT = 200;

// Adds a subscription for the given collection/query; the subscriber-fanout package
// handles the actual change-stream delivery. Query is scoped to the user's ability here
// so subscriber-fanout doesn't need to re-check access.
export const func = withWebSocketContext<APIGatewayProxyWebsocketEventV2>(async (event, context, logger) => {
  const endpoint = Resource.websocket.managementEndpoint;
  const connectionId = event.requestContext.connectionId;

  const {
    accessToken,
    subscriptionId: clientSubscriberId,
    collectionName,
    query,
    fields,
    fetchInitialData,
  } = DataSubscribeRequestAction.parse(JSON.parse(event.body ?? ''));

  const secretRotation = await secretRotationRepository.findByKeyName('JWT_SECRET');
  let previousSecret = undefined;
  // If JWT_SECRET was just recently renewed within 24 hours, allow the user to continue using the old key
  if (dayjs(secretRotation?.rotatedAt).isBefore(dayjs().add(1, 'day'))) {
    previousSecret = secretRotation?.previousKey;
  }
  const decoded = authTokenGenerator.verifyToken(accessToken!, previousSecret) as jwt.JwtPayload;

  const user = await User.findById(decoded.id);
  if (!user) throw new NotFoundError('User not found');
  const userAbility = ability(user);

  // 'scope' limits the scope of the query, to only things you're allowed to see.
  // mostly it uses the accessibleBy function from the casl/mongoose package.  There
  // are some cases where a Model isn't handled by casl/mongoose, and we handle those
  // cases explicitly.
  let scope: mongoose.FilterQuery<unknown>;
  if (collectionName === Quest.collection.collectionName) {
    const accessibleSessions = await SessionModel.find(accessibleBy(userAbility).ofType(SessionModel), { _id: true });
    scope = { sessionId: { $in: accessibleSessions.map(s => s._id) } };
  } else if (collectionName === QuestMasterPlan.collection.collectionName) {
    const accessibleSessions = await SessionModel.find(accessibleBy(userAbility).ofType(SessionModel), { _id: true });
    // Plan access is user-based (owner/shared/public) with a session-based
    // fallback for legacy and session-visibility plans
    scope = questMasterPlanSubscriptionScope(
      user._id.toString(),
      accessibleSessions.map(s => s._id)
    );
  } else if (collectionName === Invite.collection.collectionName) {
    const canShareProjectsQuery = accessibleBy(userAbility, Permission.share).ofType(Project);
    const shareableProjectIds = await Project.find(canShareProjectsQuery).distinct('_id');
    scope = {
      $or: [
        { 'recipients.pending': { $in: [user.email] } },
        {
          $and: [{ type: InviteType.Project }, { documentId: { $in: shareableProjectIds.map(id => id.toString()) } }],
        },
      ],
    };
  } else {
    // To make a collection subscribeable, add it to this scope mapping:
    scope = {
      [User.collection.collectionName]: { _id: user._id },
      [SessionModel.collection.collectionName]: accessibleBy(userAbility).ofType(SessionModel),
      [FabFile.collection.collectionName]: accessibleBy(userAbility).ofType(FabFile),
      [AdminSettings.collection.collectionName]: accessibleBy(userAbility).ofType(AdminSettings),
      [Inbox.collection.collectionName]: { receiverId: user._id },
      [ApiKey.collection.collectionName]: accessibleBy(userAbility).ofType(ApiKey),
      [Organization.collection.collectionName]: accessibleBy(userAbility).ofType(Organization),
      [AppFile.collection.collectionName]: accessibleBy(userAbility).ofType(AppFile),
      [Project.collection.collectionName]: accessibleBy(userAbility).ofType(Project),
      [Subscription.collection.collectionName]: accessibleBy(userAbility).ofType(Subscription),
      [Artifact.collection.collectionName]: accessibleBy(userAbility).ofType(Artifact),
      [ArtifactVersion.collection.collectionName]: accessibleBy(userAbility).ofType(ArtifactVersion),
      // [DELETION-FOOTPRINT] premium-bob run doc: the reading screen live-subscribes to its
      // bob_runs doc by _id (issue #33). Owner-scoped so a user only sees their own runs. Literal
      // string because the model lives in the overlay (not importable here); `userId` is a String
      // field, so match the stringified id. This ownership rule (own runs only) MUST stay in sync
      // with the GET /api/premium-bob/runs/:id polling route's read check (assertCanReadRun) so the
      // poll can't leak what the socket wouldn't. Removed when Bob is extracted.
      ['bob_runs']: { userId: user._id.toString() },
    }[collectionName];
  }

  const fieldLimits = {
    users: {
      password: false,
      stripeCustomerId: false,
      resetPasswordToken: false,
    },
  }[collectionName];

  let scopedFields: undefined | Record<string, boolean | number> = (fields || fieldLimits) && {
    ...fields,
    ...fieldLimits,
  };

  if (scopedFields) {
    const inclusions = pickBy(scopedFields, v => v);
    if (Object.keys(inclusions).length) {
      const haveExclusions = Object.values(scopedFields).some(v => !v);
      if (haveExclusions) {
        throw new Error('Cannot mix exclusions and inclusions');
      }
      scopedFields = {
        ...inclusions,
        deletedAt: true,
      };
    }
  }

  if (!scope) {
    throw new Error(`Invalid collectionName: ${collectionName}`);
  }

  const collection = findModelByCollectionName(collectionName);
  if (!collection) {
    // Shouldn't happen, we'd already verified scope
    throw new Error(`Invalid collectionName: ${collectionName}`);
  }

  const scopedQuery = { $and: [query, scope] };
  const findPromise = collection
    .find(scopedQuery, scopedFields ?? undefined)
    .setOptions({ includeDeleted: true, limit: HARD_LIMIT });
  const normalizedQuery = findPromise.getQuery();
  const subscriber = { endpoint, connectionId, clientId: clientSubscriberId, attempts: 0 };

  if (fetchInitialData) {
    const results = await findPromise;
    const limit = pLimit(50);
    const sendingOutcomes = await Promise.allSettled(
      results.map(r =>
        limit(() => {
          const payload = r.deletedAt
            ? { operationType: 'delete', data: { _id: r._id.toString(), id: r.id } }
            : { operationType: 'insert', data: r.toJSON() };
          return sendToConnection(connectionId, endpoint, {
            action: 'data_update',
            subscriptionId: clientSubscriberId,
            collectionName,
            ...payload,
          });
        })
      )
    );

    sendingOutcomes.forEach((outcome, i) => {
      if (outcome.status === 'rejected') {
        // DEBUG: Set to true to enable verbose WebSocket error logging
        const doVerbose = false;

        if (doVerbose) {
          const log = outcome.reason instanceof GoneException ? logger.info.bind(logger) : logger.error.bind(logger);
          log(`Failed to send update ${collectionName} ${i} to connection ${connectionId}: ${outcome.reason}`);
        }
      }
    });
  }

  const uniqueQuerySelector = crypto
    .createHash('sha256')
    .update(JSON.stringify(collectionName))
    .update(JSON.stringify(normalizedQuery))
    .update(JSON.stringify(scopedFields))
    .digest('base64');

  const result = await QuerySubscription.findOneAndUpdate(
    { queryId: uniqueQuerySelector },
    {
      $addToSet: { subscribers: subscriber },
      $setOnInsert: {
        queryId: uniqueQuerySelector,
        collectionName,
        query: normalizedQuery,
        fields: scopedFields,
      },
    },
    { upsert: true, new: true }
  );
  if (result) {
    // no-op
  } else {
    logger.error(`Failed to subscribe client ${clientSubscriberId} to ${collectionName}`);
    throw new Error(`Failed to subscribe client ${clientSubscriberId} to ${collectionName}`);
  }

  return { statusCode: 200 };
});
