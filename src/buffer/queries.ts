// Every operation Relaypost sends to Buffer. test/queries.test.ts validates each
// one against the live public schema (introspected 3-nov-2026), so a field that
// does not exist fails the build instead of failing in front of a judge.

export const ACCOUNT_QUERY = /* GraphQL */ `
  query Account {
    account {
      id
      name
      avatar
      organizations { id name }
    }
  }
`

export const CHANNELS_QUERY = /* GraphQL */ `
  query Channels($organizationId: OrganizationId!) {
    channels(input: { organizationId: $organizationId }) {
      id
      name
      displayName
      service
      avatar
      timezone
      isDisconnected
      isQueuePaused
    }
  }
`

export const TAGS_QUERY = /* GraphQL */ `
  query Tags($organizationId: OrganizationId!) {
    tagsV2(first: 100, input: { organizationId: $organizationId }) {
      edges { node { id name color } }
    }
  }
`

const POST_FIELDS = /* GraphQL */ `
  fragment RelayPost on Post {
    id
    text
    status
    dueAt
    sentAt
    externalLink
    channelId
    channelService
    tags { id name color }
    assets {
      type
      source
      thumbnail
      ... on ImageAsset { image { altText } }
    }
    error { message supportUrl }
  }
`

// One call returns every post in a time window that matches the relay rules.
// Filters are ANDed by Buffer, so tag rules and channel rules are separate calls.
export const POSTS_QUERY = /* GraphQL */ `
  query Posts($organizationId: OrganizationId!, $filter: PostsFiltersInput, $first: Int, $after: String) {
    posts(first: $first, after: $after, input: { organizationId: $organizationId, filter: $filter, sort: [{ field: dueAt, direction: asc }] }) {
      edges { node { ...RelayPost } }
      pageInfo { hasNextPage endCursor }
    }
  }
  ${POST_FIELDS}
`

export const CREATE_TAG_MUTATION = /* GraphQL */ `
  mutation CreateTag($organizationId: OrganizationId!, $name: String!, $color: String!) {
    createTag(input: { organizationId: $organizationId, tag: { name: $name, color: $color } }) {
      ... on TagActionSuccess { tag { id name color } }
      ... on MutationError { message }
    }
  }
`

// Only tagIds is sent: mode is omitted, which per the schema keeps the post's
// schedule, queue slot and custom time untouched.
export const SET_POST_TAGS_MUTATION = /* GraphQL */ `
  mutation SetPostTags($id: PostId!, $tagIds: [TagId!]) {
    editPost(input: { id: $id, tagIds: $tagIds }) {
      ... on PostActionSuccess { post { ...RelayPost } }
      ... on MutationError { message }
    }
  }
  ${POST_FIELDS}
`

export type PostStatus = 'draft' | 'error' | 'needs_approval' | 'scheduled' | 'sending' | 'sent'

export interface BufferTag {
  id: string
  name: string
  color: string
}

export interface BufferAsset {
  type: string
  source: string
  thumbnail: string
  image?: { altText: string }
}

export interface BufferPost {
  id: string
  text: string
  status: PostStatus
  dueAt: string | null
  sentAt: string | null
  externalLink: string | null
  channelId: string
  channelService: string
  tags: BufferTag[]
  assets: BufferAsset[]
  error: { message: string; supportUrl: string | null } | null
}

export interface BufferChannel {
  id: string
  name: string
  displayName: string | null
  service: string
  avatar: string
  timezone: string
  isDisconnected: boolean
  isQueuePaused: boolean
}

export interface BufferAccount {
  id: string
  name: string | null
  avatar: string
  organizations: { id: string; name: string }[]
}
