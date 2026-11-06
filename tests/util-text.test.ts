/**
 * 文本工具单测：sha256 / 归一化 / 列表渲染 / 确定性序列化。
 * 运行：node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { bulletize, normalizeText, sha256, stableStringify } from '../src/util/text.ts'

test('sha256：已知向量', () => {
  assert.equal(sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assert.equal(sha256('中文'), sha256('中文'))
  assert.notEqual(sha256('中文'), sha256('中'))
})

test('normalizeText：BOM / CRLF / 行尾空白 / 连续空行', () => {
  assert.equal(normalizeText('\uFEFFa\r\nb\r\n\r\n\r\nc  \n'), 'a\nb\n\nc')
  assert.equal(normalizeText('  \n\n  '), '')
  assert.equal(normalizeText('a\u200Bb'), 'ab')
})

test('bulletize：过滤空行、限条数、Markdown 列表', () => {
  assert.equal(bulletize(['a', '', '  ', 'b', 'c'], 2), '- a\n- b')
  assert.equal(bulletize(['a'], 0), '')
  assert.equal(bulletize([], 5), '')
})

test('stableStringify：键排序、数组保序、跳过 undefined', () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }))
  assert.equal(stableStringify({ a: 1, b: undefined }), '{"a":1}')
  assert.equal(stableStringify([3, 1, 2]), '[3,1,2]')
  assert.equal(stableStringify({ list: [{ z: 1, a: 2 }] }), '{"list":[{"a":2,"z":1}]}')
  assert.equal(stableStringify(null), 'null')
})
