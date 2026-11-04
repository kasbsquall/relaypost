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

// One post by id: used when a failed handoff is retried by hand, possibly hours later.
export const POST_QUERY = /* GraphQL */ `
  query Post($id: PostId!) {
    post(input: { id: $id }) { ...RelayPost }
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

// mode is omitted, which per the schema keeps the post's schedule, queue slot and
// custom time untouched; assets are omitted, which keeps them. text is sent back
// unchanged: the live API rejected a tags-only edit on 3 Nov 2026 with "Post must
// have either text or media" although the schema says omitting text keeps it.
export const SET_POST_TAGS_MUTATION = /* GraphQL */ `
  mutation SetPostTags($id: PostId!, $tagIds: [TagId!], $text: String) {
    editPost(input: { id: $id, tagIds: $tagIds, text: $text }) {
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

// needs_approval is left out on purpose: on 3 Nov 2026 the live API returned no
// posts at all whenever needs_approval was in the status list, even though the
// schema accepts it. A post waiting for approval is picked up once it is scheduled.
export const SYNC_STATUSES: PostStatus[] = ['scheduled', 'sending', 'sent', 'error']
export const QUEUE_STATUSES: PostStatus[] = ['scheduled']

// Filters for one sync pass: one read for tag rules, one for channel rules.
// PostsFiltersInput takes tags as a TagComparator ({ in, isEmpty }), not a list
// of ids; test/queries.test.ts coerces these against the schema.
export function syncFilters(
  window: { start: number; end: number },
  statuses: PostStatus[],
  tagIds: string[],
  channelIds: string[],
): Record<string, unknown>[] {
  const base = { status: statuses, dueAt: { start: new Date(window.start).toISOString(), end: new Date(window.end).toISOString() } }
  const filters: Record<string, unknown>[] = []
  if (tagIds.length) filters.push({ ...base, tags: { in: tagIds, isEmpty: false } })
  if (channelIds.length) filters.push({ ...base, channelIds })
  return filters
}

// Variables for SET_POST_TAGS_MUTATION, built from the post as Buffer last
// returned it so the browser never decides the tag list or the text.
export function tagEditVariables(post: Pick<BufferPost, 'id' | 'text' | 'tags'>, tagId: string, on: boolean): Record<string, unknown> {
  const current = post.tags.map((t) => t.id)
  const tagIds = on ? [...new Set([...current, tagId])] : current.filter((id) => id !== tagId)
  // A media-only post has no text to send back; omitting it keeps the media.
  return post.text ? { id: post.id, tagIds, text: post.text } : { id: post.id, tagIds }
}
