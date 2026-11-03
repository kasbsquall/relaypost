import { readFileSync } from 'node:fs'
import { buildClientSchema, parse, validate, type IntrospectionQuery } from 'graphql'
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
