# MisskeyLLM Codebase Guidelines

## Build Commands
- Deno run: `deno run --allow-net --allow-read --allow-write --allow-env bot.ts`
- Compile to executable: `deno compile --allow-net --allow-read --allow-write --allow-env bot.ts`

## Lint Commands
- Lint: `deno lint`
- Format: `deno fmt`

## Test Commands
- Run tests: `deno test`
- Run single test file: `deno test tests/filename.test.ts`
- Run tests with coverage: `deno test --coverage=.coverage && deno coverage .coverage`

## Code Style Guidelines

### Imports
- Use ES modules with import/export syntax
- External dependencies via JSR or NPM (Deno compatible)
- Group imports: Standard libraries, external libraries, local imports
- Use specific imports: `import { function } from "module"` instead of `import * as module`

### Formatting
- Indentation: 2 spaces (no tabs)
- Line width: 120 characters
- Semicolons: Always used
- Quotes: Double quotes for strings
- Trailing commas: Used in multi-line objects/arrays

### Types
- Use TypeScript with strict mode enabled
- Explicit typing for function parameters and return values
- Prefer interfaces over types for object shapes
- Use `unknown` instead of `any` when type is truly unknown

### Naming Conventions
- Variables: camelCase
- Functions: camelCase
- Classes/Interfaces: PascalCase
- Constants: UPPER_SNAKE_CASE
- Type aliases: PascalCase
- File names: kebab-case.ts

### Error Handling
- Always handle errors with try/catch blocks
- Use logger.error for error reporting
- Avoid silent error swallowing
- Use specific error types when possible

### Documentation
- Use JSDoc for function documentation
- Comment complex logic with inline comments
- Exported functions should have clear doc comments

## Environment
- Uses Deno runtime
- Configuration via environment variables
- Dependencies managed through deno.json

## Memory Management
- Conversation memory stored in memory.json
- Redis support for distributed memory
- Automatic memory trimming based on MAX_MEMORY setting