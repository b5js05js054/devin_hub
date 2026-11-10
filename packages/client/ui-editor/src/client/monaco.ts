import * as monaco from 'monaco-editor/esm/vs/editor/edcore.main.js'
import * as python from 'monaco-editor/esm/vs/basic-languages/python/python.js'
import * as typescript from 'monaco-editor/esm/vs/basic-languages/typescript/typescript.js'
import * as javascript from 'monaco-editor/esm/vs/basic-languages/javascript/javascript.js'
import * as css from 'monaco-editor/esm/vs/basic-languages/css/css.js'
import * as html from 'monaco-editor/esm/vs/basic-languages/html/html.js'
import * as markdown from 'monaco-editor/esm/vs/basic-languages/markdown/markdown.js'
import * as shell from 'monaco-editor/esm/vs/basic-languages/shell/shell.js'
import * as yaml from 'monaco-editor/esm/vs/basic-languages/yaml/yaml.js'
import * as xml from 'monaco-editor/esm/vs/basic-languages/xml/xml.js'
import * as go from 'monaco-editor/esm/vs/basic-languages/go/go.js'
import * as rust from 'monaco-editor/esm/vs/basic-languages/rust/rust.js'
import * as java from 'monaco-editor/esm/vs/basic-languages/java/java.js'
import * as sql from 'monaco-editor/esm/vs/basic-languages/sql/sql.js'

interface Grammar {
  readonly conf: monaco.languages.LanguageConfiguration
  readonly language: monaco.languages.IMonarchLanguage
}

const json: Grammar = {
  conf: {
    brackets: [['{', '}'], ['[', ']']],
    autoClosingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '"', close: '"', notIn: ['string'] }],
  },
  language: {
    tokenizer: {
      root: [
        [/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'string.key'],
        [/"(?:[^"\\]|\\.)*"/, 'string'],
        [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number'],
        [/\b(?:true|false|null)\b/, 'keyword'],
        [/\/\/.*$/, 'comment'],
        [/\/\*/, 'comment', '@comment'],
        [/[{}[\]]/, '@brackets'],
      ],
      comment: [[/[^*/]+/, 'comment'], [/\*\//, 'comment', '@pop'], [/[*/]/, 'comment']],
    },
  },
}

const GRAMMARS: ReadonlyArray<readonly [string, readonly string[], Grammar]> = [
  ['python', ['.py', '.pyw'], python],
  ['typescript', ['.ts', '.tsx', '.mts', '.cts'], typescript],
  ['javascript', ['.js', '.jsx', '.mjs', '.cjs'], javascript],
  ['json', ['.json', '.jsonc'], json],
  ['css', ['.css'], css],
  ['html', ['.html', '.htm'], html],
  ['markdown', ['.md', '.markdown'], markdown],
  ['shell', ['.sh', '.bash'], shell],
  ['yaml', ['.yml', '.yaml'], yaml],
  ['xml', ['.xml', '.svg'], xml],
  ['go', ['.go'], go],
  ['rust', ['.rs'], rust],
  ['java', ['.java'], java],
  ['sql', ['.sql'], sql],
]

for (const [id, extensions, grammar] of GRAMMARS) {
  monaco.languages.register({ id, extensions: [...extensions] })
  monaco.languages.setLanguageConfiguration(id, grammar.conf)
  monaco.languages.setMonarchTokensProvider(id, grammar.language)
}

const scope = globalThis as { MonacoEnvironment?: unknown }
scope.MonacoEnvironment ??= { getWorker: () => { throw new Error('ui-editor: Monaco runs without workers') } }

export { monaco }
