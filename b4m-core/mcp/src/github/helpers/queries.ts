/**
 * GitHub MCP Server - GraphQL Query Constants
 *
 * Centralized GraphQL queries for GitHub Projects v2 operations.
 */

// Organization projects queries

export const LIST_ORG_PROJECTS_QUERY = `
  query($org: String!, $first: Int!, $after: String) {
    organization(login: $org) {
      projectsV2(first: $first, after: $after) {
        nodes {
          id
          title
          shortDescription
          public
          closed
          url
          number
          createdAt
          updatedAt
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

// Project fields queries

export const LIST_PROJECT_FIELDS_QUERY = `
  query($projectId: ID!, $first: Int!) {
    node(id: $projectId) {
      ... on ProjectV2 {
        fields(first: $first) {
          nodes {
            ... on ProjectV2Field {
              id
              name
              dataType
            }
            ... on ProjectV2SingleSelectField {
              id
              name
              dataType
              options {
                id
                name
                color
              }
            }
            ... on ProjectV2IterationField {
              id
              name
              dataType
              configuration {
                iterations {
                  id
                  title
                  startDate
                  duration
                }
              }
            }
          }
        }
      }
    }
  }
`;

// Project item queries

export const GET_PROJECT_ITEM_QUERY = `
  query($projectId: ID!, $cursor: String) {
    node(id: $projectId) {
      ... on ProjectV2 {
        items(first: 100, after: $cursor) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            content {
              ... on Issue {
                id
                number
                title
              }
            }
            fieldValues(first: 50) {
              nodes {
                ... on ProjectV2ItemFieldTextValue {
                  text
                  field {
                    ... on ProjectV2Field {
                      id
                      name
                    }
                  }
                }
                ... on ProjectV2ItemFieldNumberValue {
                  number
                  field {
                    ... on ProjectV2Field {
                      id
                      name
                    }
                  }
                }
                ... on ProjectV2ItemFieldDateValue {
                  date
                  field {
                    ... on ProjectV2Field {
                      id
                      name
                    }
                  }
                }
                ... on ProjectV2ItemFieldSingleSelectValue {
                  name
                  field {
                    ... on ProjectV2SingleSelectField {
                      id
                      name
                    }
                  }
                }
                ... on ProjectV2ItemFieldIterationValue {
                  title
                  field {
                    ... on ProjectV2IterationField {
                      id
                      name
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

export const ADD_PROJECT_ITEM_MUTATION = `
  mutation($projectId: ID!, $contentId: ID!) {
    addProjectV2ItemById(input: {
      projectId: $projectId
      contentId: $contentId
    }) {
      item {
        id
      }
    }
  }
`;

// Project item field update mutations

export const UPDATE_NUMBER_FIELD_MUTATION = `
  mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: Float!) {
    updateProjectV2ItemFieldValue(input: {
      projectId: $projectId
      itemId: $itemId
      fieldId: $fieldId
      value: { number: $value }
    }) {
      projectV2Item {
        id
      }
    }
  }
`;

export const UPDATE_DATE_FIELD_MUTATION = `
  mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: Date!) {
    updateProjectV2ItemFieldValue(input: {
      projectId: $projectId
      itemId: $itemId
      fieldId: $fieldId
      value: { date: $value }
    }) {
      projectV2Item {
        id
      }
    }
  }
`;

export const UPDATE_ITERATION_FIELD_MUTATION = `
  mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: String!) {
    updateProjectV2ItemFieldValue(input: {
      projectId: $projectId
      itemId: $itemId
      fieldId: $fieldId
      value: { iterationId: $value }
    }) {
      projectV2Item {
        id
      }
    }
  }
`;

export const UPDATE_TEXT_FIELD_MUTATION = `
  mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: String!) {
    updateProjectV2ItemFieldValue(input: {
      projectId: $projectId
      itemId: $itemId
      fieldId: $fieldId
      value: { text: $value }
    }) {
      projectV2Item {
        id
      }
    }
  }
`;

export const UPDATE_SINGLE_SELECT_FIELD_MUTATION = `
  mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: String!) {
    updateProjectV2ItemFieldValue(input: {
      projectId: $projectId
      itemId: $itemId
      fieldId: $fieldId
      value: { singleSelectOptionId: $value }
    }) {
      projectV2Item {
        id
      }
    }
  }
`;

// Pull request draft status mutations

export const MARK_PR_READY_FOR_REVIEW_MUTATION = `
  mutation MarkPullRequestReadyForReview($pullRequestId: ID!) {
    markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
      pullRequest {
        id
        isDraft
        number
        title
      }
    }
  }
`;

export const CONVERT_PR_TO_DRAFT_MUTATION = `
  mutation ConvertPullRequestToDraft($pullRequestId: ID!) {
    convertPullRequestToDraft(input: { pullRequestId: $pullRequestId }) {
      pullRequest {
        id
        isDraft
        number
        title
      }
    }
  }
`;

// Repository info queries (for whitelist validation)

export const GET_REPOSITORY_FROM_ISSUE_NODE_ID_QUERY = `
  query($nodeId: ID!) {
    node(id: $nodeId) {
      ... on Issue {
        repository {
          owner {
            login
          }
          name
        }
      }
    }
  }
`;

export const GET_REPOSITORY_FROM_PROJECT_ITEM_ID_QUERY = `
  query($itemId: ID!) {
    node(id: $itemId) {
      ... on ProjectV2Item {
        content {
          ... on Issue {
            repository {
              owner {
                login
              }
              name
            }
          }
        }
      }
    }
  }
`;
