/**
 * JSON 提取单测：围栏 / 前后废话 / 坏 JSON（尾随逗号、注释）/ 失败抛错。
 * 运行：node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { extractJson, JsonParseError } from '../src/model/json.ts'

test('extractJson：裸 JSON', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 })
  assert.deepEqual(extractJson('[1,2,3]'), [1, 2, 3])
  assert.deepEqual(extractJson('  \n {"a": {"b": [true, null]}} \n '), { a: { b: [true, null] } })
})

test('extractJson：```json 围栏 + 前后废话', () => {
  const text = '好的，结果如下：\n```json\n{"events": [], "narrative": "今天"}\n```\n以上就是全部内容。'
  assert.deepEqual(extractJson(text), { events: [], narrative: '今天' })

  const noLang = '```\n{"ok":true}\n```'
  assert.deepEqual(extractJson(noLang), { ok: true })
})

test('extractJson：无围栏的废话 + 平衡括号切片', () => {
  assert.deepEqual(extractJson('以下是结果：{"a": 1} 完毕'), { a: 1 })
  assert.deepEqual(extractJson('前面有 {干扰} 然后 {"real": 2} 后面'), { real: 2 })
  // 字符串里的括号不应破坏配对
  assert.deepEqual(extractJson('{"a": "{不是括号}"}'), { a: '{不是括号}' })
})

test('extractJson：坏 JSON 一次修复（尾随逗号 + 注释）', () => {
  const text = '```json\n{\n  "a": 1, // 行注释\n  "b": [1, 2,],\n  /* 块注释 */\n  "c": "x",\n}\n```'
  assert.deepEqual(extractJson(text), { a: 1, b: [1, 2], c: 'x' })
})

test('extractJson：完全不是 JSON 时抛 JsonParseError', () => {
  assert.throws(
    () => extractJson('抱歉，我无法完成这个请求。'),
    (error: unknown) => error instanceof JsonParseError && error.raw.includes('抱歉'),
  )
  assert.throws(() => extractJson(''), JsonParseError)
  // JSON 语法损坏且无法修复时也抛错，而不是返回半个对象
  assert.throws(() => extractJson('{"a": '), JsonParseError)
})
