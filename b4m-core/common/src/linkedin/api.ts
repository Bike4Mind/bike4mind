export const LINKEDIN_API_VERSION = '202604';

export type OrganizationLookupResponse = {
  paging: {
    start: number;
    count: number;
    links: { type: string; rel: string; href: string }[];
    total: number;
  };
  elements: Organization[] | null;
};

export type Organization = {
  id: string;
  name: string;
  localizedName: string;
  localizedWebsite: string;
  vanityName: string;
  logoV2: string;
  locations: string[];
  primaryOrganizationType: string;
};

type UserInfoResponse = {
  id: string;
  givenName: string;
  familyName: string;
  emailAddress: string;
  picture: string;
};

type PostLookupResponse = {
  elements: Post[];
  paging: {
    start: number;
    count: number;
    links: { type: string; rel: string; href: string }[];
    total: number;
  };
};

type Post = {
  id: string;
  author: string;
  lastModifiedAt: number;
  publishedAt: number;
  visibility: string;
  lifecycleState: string;
  isReshareDisabledByAuthor: boolean;
  createdAt: number;
  distribution: {
    feedDistribution?: string;
    thirdPartyDistributionChannels?: string[];
  };
  content: {
    article?: {
      title?: string;
      description?: string;
      thumbnail?: string;
    };
    media?: {
      type: string;
      title?: string;
      description?: string;
      id?: string;
    };
  };
  commentary: string;
  lifecycleStateInfo: Record<string, unknown>;
};

type RefreshAccessTokenResponse = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  scope?: string;
};

export interface SocialMetadataResponse {
  commentState: string;
  entity: string;
  commentSummary: {
    count: number;
    topLevelCount: number;
  };
  reactionSummaries: {
    [key: string]: {
      count: number;
      reactionType: string;
    };
  };
}

interface BatchSocialMetadataResponse {
  statuses: {
    [key: string]: {
      status: string;
      entity: string;
    };
  };
  results: {
    [key: string]: SocialMetadataResponse;
  };
  errors: {
    [key: string]: {
      code: string;
      message: string;
    };
  };
}

export type ShareStatistics = {
  organizationalEntity: string;
  ugcPost?: string;
  share?: string;
  totalShareStatistics: {
    clickCount: number;
    commentCount: number;
    engagement: number;
    impressionCount: number;
    likeCount: number;
    shareCount: number;
  };
};
export interface BatchShareStatisticsResponse {
  elements: Array<ShareStatistics>;
  paging: {
    start: number;
    count: number;
    links: { type: string; rel: string; href: string }[];
    total: number;
  };
}

/**
 * @security Static methods (getCompany, refreshAccessToken) use bare fetch() - they are NOT
 * wrapped in the adapter's safeFetch() SSRF guard. This is safe here because all URLs are
 * hardcoded constants (no user-supplied input), but callers outside the LinkedInAdapter MUST
 * NOT pass dynamic URLs through these methods. Defense-in-depth migration to safeFetch is
 * still pending.
 */
export class LinkedInApi {
  private readonly accessToken: string;
  constructor(accessToken: string) {
    this.accessToken = accessToken;
  }

  /**
   * Refresh the LinkedIn access token using the refresh token.
   * Returns the full response data from LinkedIn, including access_token, expires_in, refresh_token, refresh_token_expires_in, etc.
   */
  static async refreshAccessToken(
    refreshToken: string,
    clientId: string,
    clientSecret: string
  ): Promise<RefreshAccessTokenResponse> {
    const params = new URLSearchParams();
    params.append('grant_type', 'refresh_token');
    params.append('refresh_token', refreshToken);
    params.append('client_id', clientId);
    params.append('client_secret', clientSecret);

    const response = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(
        `Failed to refresh access token: ${response.status} ${response.statusText} - ${error.slice(0, 200)}`
      );
    }

    const data = (await response.json()) as RefreshAccessTokenResponse;
    return data;
  }

  getCompany = async (vanityName: string) => {
    const orgsResponse = await fetch(
      `https://api.linkedin.com/rest/organizations/?q=vanityName&vanityName=${encodeURIComponent(vanityName)}`,
      {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'LinkedIn-Version': LINKEDIN_API_VERSION,
          'X-Restli-Protocol-Version': '2.0.0',
        },
        signal: AbortSignal.timeout(15_000),
      }
    );
    if (!orgsResponse.ok) {
      console.error(JSON.stringify({ status: orgsResponse.status, statusText: orgsResponse.statusText }));
      throw new Error(`Failed to fetch organizations ${orgsResponse.statusText}`);
    }

    const orgsData = (await orgsResponse.json()) as OrganizationLookupResponse;
    // LinkedIn REST API can return { elements: null } on rate limit or permission conditions
    const company = orgsData.elements?.[0];
    return company;
  };

  getUserInfo = async () => {
    const profileResponse = await fetch('https://api.linkedin.com/v2/userinfo', {
      headers: { Authorization: `Bearer ${this.accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });

    if (!profileResponse.ok) {
      console.error(JSON.stringify({ status: profileResponse.status, statusText: profileResponse.statusText }));
      throw new Error(`Failed to fetch profile ${profileResponse.statusText}`);
    }

    const profile = (await profileResponse.json()) as UserInfoResponse;
    return profile;
  };

  getPosts = async (urn: string, start = 0, limit = 10): Promise<PostLookupResponse> => {
    // 2. Get user's posts using the new Posts API with pagination
    const postsResponse = await fetch(
      `https://api.linkedin.com/rest/posts?author=${encodeURIComponent(urn)}&q=author&count=${limit}&start=${start}`,
      {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'LinkedIn-Version': LINKEDIN_API_VERSION,
          'X-RestLi-Method': 'FINDER',
          'X-Restli-Protocol-Version': '2.0.0',
        },
      }
    );
    if (!postsResponse.ok) {
      console.error(JSON.stringify({ status: postsResponse.status, statusText: postsResponse.statusText }));
      throw new Error(`Failed to fetch posts ${postsResponse.statusText}`);
    }
    const posts = (await postsResponse.json()) as PostLookupResponse;
    return posts;
  };

  getSocialMetadata = async (postId: string) => {
    const statsResponse = await fetch(`https://api.linkedin.com/rest/socialMetadata/${encodeURIComponent(postId)}`, {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'LinkedIn-Version': LINKEDIN_API_VERSION,
        'X-Restli-Protocol-Version': '2.0.0',
      },
    });
    if (!statsResponse.ok) {
      console.error(JSON.stringify({ status: statsResponse.status, statusText: statsResponse.statusText }));
      throw new Error(`Failed to fetch stats ${statsResponse.statusText}`);
    }
    const stats = (await statsResponse.json()) as SocialMetadataResponse;
    return stats;
  };

  batchGetSocialMetadata = async (postIds: string[]) => {
    const statsResponse = await fetch(
      `https://api.linkedin.com/rest/socialMetadata?ids=List(${postIds.map(id => `${encodeURIComponent(id)}`).join(',')})`,
      {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'LinkedIn-Version': LINKEDIN_API_VERSION,
          'X-Restli-Protocol-Version': '2.0.0',
        },
      }
    );
    if (!statsResponse.ok) {
      console.error(JSON.stringify({ status: statsResponse.status, statusText: statsResponse.statusText }));
      throw new Error(`Failed to fetch stats ${statsResponse.statusText}`);
    }
    const stats = (await statsResponse.json()) as BatchSocialMetadataResponse;
    return stats;
  };

  /**
   * Get share statistics for a specific UGC post (share) for an organization.
   * @param organizationUrn e.g. 'urn:li:organization:123456'
   * @param shareUrn e.g. 'urn:li:share:abcdefg'
   * @returns The share statistics object from LinkedIn
   */
  getShareStatistics = async (organizationUrn: string, shareUrns: string[], ugcPosts: string[]) => {
    let shareUrnQuery = '';
    let ugcPostQuery = '';
    if (shareUrns.length) {
      shareUrnQuery = `&shares=List(${shareUrns.map(id => `${encodeURIComponent(id)}`).join(',')})`;
    }
    if (ugcPosts.length) {
      ugcPostQuery = `&ugcPosts=List(${ugcPosts.map(id => `${encodeURIComponent(id)}`).join(',')})`;
    }
    const url = `https://api.linkedin.com/rest/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${encodeURIComponent(organizationUrn as string)}${shareUrnQuery}${ugcPostQuery}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'LinkedIn-Version': LINKEDIN_API_VERSION,
        'X-Restli-Protocol-Version': '2.0.0',
      },
    });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(
        `Failed to fetch share statistics: ${response.status} ${response.statusText} - ${error.slice(0, 200)}`
      );
    }
    return (await response.json()) as BatchShareStatisticsResponse;
  };
}
