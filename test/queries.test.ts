import { readFileSync } from 'node:fs'
import { buildClientSchema, coerceInputValue, parse, validate, type GraphQLInputType, type IntrospectionQuery } from 'graphql'
import { describe, expect, it } from 'vitest'
import * as q from '../src/buffer/queries'

const introspection = JSON.parse(readFileSync(new URL('./buffer-schema.json', import.meta.url), 'utf8')) as {
  data: IntrospectionQuery
}
const schema = buildClientSchema(introspection.data)

const operations = {
  ACCOUNT_QUERY: q.ACCOUNT_QUERY,
  CHANNELS_QUERY: q.CHANNELS_QUERY,
  TAGS_QUERY: q.TAGS_QUERY,
  POSTS_QUERY: q.POSTS_QUERY,
  CREATE_TAG_MUTATION: q.CREATE_TAG_MUTATION,
  SET_POST_TAGS_MUTATION: q.SET_POST_TAGS_MUTATION,
}

describe('Buffer operations match the public schema', () => {
  for (const [name, source] of Object.entries(operations)) {
    it(`${name} validates`, () => {
      const errors = validate(schema, parse(source)).map((e) => e.message)
      expect(errors).toEqual([])
    })
  }

  it('PostStatus union in code equals the schema enum', () => {
    const values = (schema.getType('PostStatus') as unknown as { getValues(): { name: string }[] }).getValues().map((v) => v.name)
    const ours: q.PostStatus[] = ['draft', 'error', 'needs_approval', 'scheduled', 'sending', 'sent']
    expect([...values].sort()).toEqual([...ours].sort())
  })
})

describe('Post filters match PostsFiltersInput', () => {
  const filterType = schema.getType('PostsFiltersInput') as GraphQLInputType

  it('every sync filter coerces against the schema', () => {
    const filters = q.syncFilters({ start: 0, end: 86_400_000 }, ['scheduled', 'sent'], ['tag-1'], ['channel-1'])
    expect(filters).toHaveLength(2)
    for (const filter of filters) expect(() => coerceInputValue(filter, filterType)).not.toThrow()
  })

  it('rejects the old tagIds shape, which Buffer does not accept', () => {
    expect(() => coerceInputValue({ tagIds: ['tag-1'] }, filterType)).toThrow()
  })

  it('skips the read for a rule kind that has no rules', () => {
    expect(q.syncFilters({ start: 0, end: 1 }, ['sent'], [], ['channel-1'])).toHaveLength(1)
    expect(q.syncFilters({ start: 0, end: 1 }, ['sent'], [], [])).toHaveLength(0)
  })
})

describe('tagEditVariables', () => {
  const post = { id: 'p1', text: 'Roast day', tags: [{ id: 't1', name: 'Community', color: '#000' }] }

  it('adds a tag and sends the current text back, as the live API requires', () => {
    expect(q.tagEditVariables(post, 't2', true)).toEqual({ id: 'p1', tagIds: ['t1', 't2'], text: 'Roast day' })
  })

  it('removes only the given tag', () => {
    expect(q.tagEditVariables(post, 't1', false)).toEqual({ id: 'p1', tagIds: [], text: 'Roast day' })
  })

  it('does not duplicate a tag that is already on the post', () => {
    expect(q.tagEditVariables(post, 't1', true).tagIds).toEqual(['t1'])
  })

  it('omits text on a media-only post so the media is kept', () => {
    expect(q.tagEditVariables({ ...post, text: '' }, 't2', true)).toEqual({ id: 'p1', tagIds: ['t1', 't2'] })
  })

  it('its variables coerce against EditPostInput', () => {
    const editType = schema.getType('EditPostInput') as GraphQLInputType
    expect(() => coerceInputValue(q.tagEditVariables(post, 't2', true), editType)).not.toThrow()
  })
})
