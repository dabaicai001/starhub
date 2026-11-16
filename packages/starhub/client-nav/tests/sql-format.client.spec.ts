// @vitest-environment jsdom
/**
 * sqlFormat(需求 5 React 化,批次 5):splitStatements 多语句拆分(忽略字符串/
 * 反引号/行注释内分号)与 formatSql 轻量格式化(关键字大写 + 子句换行,不伤
 * 字符串与标识符)。纯函数全覆盖。
 */
import { describe, expect, it } from 'vitest'
import { formatSql, splitStatements } from '../src/client/sqlFormat.ts'

describe('splitStatements', () => {
  it('returns an empty array for empty or whitespace input', () => {
    expect(splitStatements('')).toEqual([])
    expect(splitStatements('   \n  ')).toEqual([])
  })

  it('splits multiple statements on semicolons', () => {
    expect(splitStatements('SELECT 1; SELECT 2;')).toEqual(['SELECT 1', 'SELECT 2'])
  })

  it('ignores semicolons inside single-quoted strings', () => {
    expect(splitStatements("INSERT INTO t VALUES ('a;b'); SELECT 1")).toEqual([
      "INSERT INTO t VALUES ('a;b')",
      'SELECT 1',
    ])
  })

  it('ignores semicolons inside backtick identifiers', () => {
    expect(splitStatements('SELECT `a;b` FROM t; SELECT 2')).toEqual([
      'SELECT `a;b` FROM t',
      'SELECT 2',
    ])
  })

  it('ignores semicolons inside line comments', () => {
    expect(splitStatements('SELECT 1 -- comment; keep\n; SELECT 2')).toEqual([
      'SELECT 1 -- comment; keep',
      'SELECT 2',
    ])
  })

  it('keeps a trailing statement without a final semicolon', () => {
    expect(splitStatements('SELECT 1; SELECT 2')).toEqual(['SELECT 1', 'SELECT 2'])
  })

  it('handles an escaped quote inside a string literal', () => {
    expect(splitStatements("SELECT 'it''s; fine'; SELECT 2")).toEqual([
      "SELECT 'it''s; fine'",
      'SELECT 2',
    ])
  })

  it('drops a leading comment and empty statements between semicolons', () => {
    expect(splitStatements('-- header\nSELECT 1;;SELECT 2')).toEqual(['SELECT 1', 'SELECT 2'])
  })

  it('keeps a trailing line comment with no final newline', () => {
    expect(splitStatements('SELECT 1 -- end')).toEqual(['SELECT 1 -- end'])
  })
})

describe('formatSql', () => {
  it('returns empty input unchanged', () => {
    expect(formatSql('')).toBe('')
    expect(formatSql('   ')).toBe('   ')
  })

  it('uppercases clause keywords and newlines major clauses', () => {
    const out = formatSql('select id, name from users where id = 1')
    expect(out).toBe('SELECT id, name\n  FROM users\n  WHERE id = 1')
  })

  it('keeps string literal contents untouched', () => {
    const out = formatSql("select 'select' as word from t where note = 'a;b'")
    expect(out).toContain("'select'")
    expect(out).toContain("'a;b'")
    expect(out).toContain('\n  FROM t')
  })

  it('matches INSERT INTO before standalone INSERT', () => {
    const out = formatSql('insert into t (a) values (1)')
    expect(out).toBe('INSERT INTO t (a)\n  VALUES (1)')
  })

  it('handles a leading keyword without an extra newline', () => {
    const out = formatSql('select * from t')
    expect(out.startsWith('SELECT')).toBe(true)
    expect(out).not.toMatch(/^\n/)
  })

  it('preserves backtick identifiers verbatim', () => {
    const out = formatSql('select `From` from t')
    expect(out).toContain('`From`')
  })

  it('does not split words that merely contain a keyword', () => {
    const out = formatSql('select offset_col from t where x = 1')
    expect(out).not.toContain('\n  OFFSET_col')
  })

  it('keeps a line comment attached to its line', () => {
    const out = formatSql('select 1 -- note\nfrom t')
    expect(out).toContain('-- note')
    expect(out).toContain('\n  FROM t')
  })

  it('handles a keyword at the very end of the input', () => {
    expect(formatSql('select 1 union')).toBe('SELECT 1\n  UNION')
  })

  it('formats a multi-clause join query with a leading comment line', () => {
    const out = formatSql('-- report\nselect a.id, b.name from t a left join u b on a.id = b.id where a.x > 0 group by b.name order by a.id limit 10')
    expect(out.startsWith('-- report\n  SELECT')).toBe(true)
    expect(out).toContain('\n  FROM t a')
    expect(out).toContain('\n  LEFT JOIN u b')
    expect(out).toContain('\n  ON a.id = b.id')
    expect(out).toContain('\n  WHERE a.x > 0')
    expect(out).toContain('\n  GROUP BY b.name')
    expect(out).toContain('\n  ORDER BY a.id')
    expect(out).toContain('\n  LIMIT 10')
  })
})
