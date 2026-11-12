import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'test/fixtures/**'
    ]
  },
  js.configs.recommended,
  {
    rules: {
      curly: ['error', 'multi-line'],
      eqeqeq: ['error', 'smart'],
      // Comments only; code length is left to review
      'max-len': ['error', {
        code: Infinity,
        comments: 100,
        ignoreUrls: true,
        // JSDoc tags and typedef members can’t be wrapped
        ignorePattern: '^\\s*(?:/\\*)?\\*+\\s*(?:@|[\\w$]+\\??:)'
      }],
      'no-shadow': 'error',
      'no-var': 'error',
      'prefer-const': 'error'
    }
  },
  {
    languageOptions: {
      globals: globals.node
    }
  },
  {
    // Functions Playwright runs in the page
    files: ['src/render.js'],
    languageOptions: {
      globals: {
        document: 'readonly',
        requestAnimationFrame: 'readonly'
      }
    }
  }
];