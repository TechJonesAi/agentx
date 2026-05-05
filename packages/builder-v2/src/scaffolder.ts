/**
 * Project Scaffolder
 *
 * Creates buildable project shells before file generation.
 * Reuses patterns from legacy builder's platform adapters.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from './logger.js';
import type { CodePlatform } from './types.js';

const log = createLogger('builder-v2:scaffolder');

export interface ScaffoldFile {
  path: string;
  content: string;
}

/**
 * Generate platform-specific scaffolding files.
 * This creates the minimal project structure before generated files are added.
 */
export function generateScaffold(
  platform: CodePlatform,
  projectDir: string,
  appName: string,
): ScaffoldFile[] {
  log.info(
    { platform, appName, projectDir },
    'Generating project scaffold'
  );

  switch (platform) {
    case 'ios':
      return generateiOSScaffold(projectDir, appName);
    case 'web':
      return generateWebScaffold(projectDir, appName);
    case 'python':
      return generatePythonScaffold(projectDir);
    case 'node':
      return generateNodeScaffold(projectDir, appName);
    default:
      log.warn({ platform }, 'Unknown platform, using generic scaffold');
      return [];
  }
}

/**
 * iOS scaffolding using XcodeGen (project.yml format).
 * Creates the minimum needed for xcodebuild to work.
 */
function generateiOSScaffold(
  projectDir: string,
  appName: string,
): ScaffoldFile[] {
  const appIdentifier = appName.toLowerCase().replace(/[^a-z0-9]/g, '');

  return [
    {
      path: path.join(projectDir, 'project.yml'),
      content: [
        `name: ${appName}`,
        'targets:',
        `  ${appName}:`,
        '    type: application',
        '    platform: iOS',
        '    deploymentTarget: "17.0"',
        '    sources: [Sources]',
        '    settings:',
        `      PRODUCT_BUNDLE_IDENTIFIER: com.example.${appIdentifier}`,
        '      GENERATE_INFOPLIST_FILE: YES',
        '      INFOPLIST_KEY_UIApplicationSceneManifest_Generation: YES',
        '      INFOPLIST_KEY_UILaunchScreen_Generation: YES',
        '      CODE_SIGNING_ALLOWED: NO',
        '      CODE_SIGNING_REQUIRED: NO',
        '      CODE_SIGN_IDENTITY: ""',
      ].join('\n'),
    },
    {
      path: path.join(projectDir, 'Sources', `${appName}App.swift`),
      content: [
        'import SwiftUI',
        '',
        '@main',
        `struct ${appName}App: App {`,
        '    var body: some Scene {',
        '        WindowGroup {',
        '            ContentView()',
        '        }',
        '    }',
        '}',
      ].join('\n'),
    },
    {
      path: path.join(projectDir, 'Sources', 'ContentView.swift'),
      content: [
        'import SwiftUI',
        '',
        'struct ContentView: View {',
        '    var body: some View {',
        '        Text("Loading...")',
        '    }',
        '}',
      ].join('\n'),
    },
  ];
}

/**
 * Web scaffolding (React/Vite).
 * Creates package.json, HTML entry, and JS entry point.
 */
function generateWebScaffold(
  projectDir: string,
  appName: string,
): ScaffoldFile[] {
  const packageJson = {
    name: appName.toLowerCase().replace(/\s+/g, '-'),
    version: '1.0.0',
    private: true,
    type: 'module',
    scripts: {
      dev: 'vite',
      build: 'tsc && vite build',
      preview: 'vite preview',
    },
    dependencies: {
      react: '^18.2.0',
      'react-dom': '^18.2.0',
    },
    devDependencies: {
      '@vitejs/plugin-react': '^4.0.0',
      typescript: '^5.0.0',
      vite: '^4.4.0',
      '@types/react': '^18.2.0',
      '@types/react-dom': '^18.2.0',
    },
  };

  return [
    {
      path: path.join(projectDir, 'package.json'),
      content: JSON.stringify(packageJson, null, 2),
    },
    {
      path: path.join(projectDir, 'tsconfig.json'),
      content: JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2020',
            useDefineForClassFields: true,
            lib: ['ES2020', 'DOM', 'DOM.Iterable'],
            module: 'ESNext',
            moduleResolution: 'node',
            skipLibCheck: true,
            esModuleInterop: true,
            allowSyntheticDefaultImports: true,
            strict: true,
            resolveJsonModule: true,
            declaration: true,
            declarationMap: true,
            sourceMap: true,
            noUnusedLocals: false,
            noUnusedParameters: true,
            noImplicitReturns: true,
            jsx: 'react-jsx',
          },
          include: ['src'],
          exclude: ['dist', 'node_modules'],
        },
        null,
        2
      ),
    },
    {
      path: path.join(projectDir, 'vite.config.ts'),
      content: [
        "import { defineConfig } from 'vite'",
        "import react from '@vitejs/plugin-react'",
        '',
        'export default defineConfig({',
        '  plugins: [react()],',
        '  server: { port: 3000 },',
        '})',
      ].join('\n'),
    },
    {
      path: path.join(projectDir, 'index.html'),
      content: [
        '<!DOCTYPE html>',
        '<html lang="en">',
        '<head>',
        '  <meta charset="UTF-8">',
        '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
        `  <title>${appName}</title>`,
        '</head>',
        '<body>',
        '  <div id="root"></div>',
        '  <script type="module" src="/src/main.tsx"></script>',
        '</body>',
        '</html>',
      ].join('\n'),
    },
    {
      path: path.join(projectDir, 'src', 'main.tsx'),
      content: [
        "import React from 'react'",
        "import ReactDOM from 'react-dom/client'",
        "import App from './App'",
        '',
        "ReactDOM.createRoot(document.getElementById('root')!).render(",
        '  <React.StrictMode>',
        '    <App />',
        '  </React.StrictMode>,',
        ')',
      ].join('\n'),
    },
    {
      path: path.join(projectDir, 'src', 'App.tsx'),
      content: [
        'export default function App() {',
        '  return (',
        '    <div style={{ padding: "20px" }}>',
        '      <h1>Loading...</h1>',
        '    </div>',
        '  )',
        '}',
      ].join('\n'),
    },
  ];
}

/**
 * Python scaffolding.
 * Minimal: requirements.txt and main.py entry point.
 */
function generatePythonScaffold(projectDir: string): ScaffoldFile[] {
  return [
    {
      path: path.join(projectDir, 'requirements.txt'),
      content: '',
    },
    {
      path: path.join(projectDir, 'main.py'),
      content: [
        '#!/usr/bin/env python3',
        '',
        'def main():',
        '    pass',
        '',
        'if __name__ == "__main__":',
        '    main()',
      ].join('\n'),
    },
  ];
}

/**
 * Node.js scaffolding.
 * package.json and basic structure.
 */
function generateNodeScaffold(
  projectDir: string,
  appName: string,
): ScaffoldFile[] {
  return [
    {
      path: path.join(projectDir, 'package.json'),
      content: JSON.stringify(
        {
          name: appName.toLowerCase().replace(/\s+/g, '-'),
          version: '1.0.0',
          type: 'module',
          main: 'dist/index.js',
          scripts: {
            build: 'tsc',
            start: 'node dist/index.js',
            dev: 'tsx src/index.ts',
          },
          dependencies: {},
          devDependencies: {
            typescript: '^5.0.0',
            tsx: '^3.12.0',
          },
        },
        null,
        2
      ),
    },
    {
      path: path.join(projectDir, 'tsconfig.json'),
      content: JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2020',
            module: 'ES2020',
            lib: ['ES2020'],
            outDir: './dist',
            rootDir: './src',
            strict: true,
            esModuleInterop: true,
            skipLibCheck: true,
            forceConsistentCasingInFileNames: true,
          },
          include: ['src'],
          exclude: ['node_modules'],
        },
        null,
        2
      ),
    },
    {
      path: path.join(projectDir, 'src', 'index.ts'),
      content: [
        'async function main() {',
        '  console.log("Hello, World!");',
        '}',
        '',
        'main().catch(console.error);',
      ].join('\n'),
    },
  ];
}

/**
 * Write all scaffold files to disk.
 */
export function writeScaffoldFiles(
  files: ScaffoldFile[],
  projectDir: string,
): number {
  let written = 0;

  for (const file of files) {
    const dir = path.dirname(file.path);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file.path, file.content, 'utf-8');
    written++;
  }

  log.info({ filesWritten: written }, 'Scaffold files written');
  return written;
}
