/**
 * Architecture Contract Generator
 *
 * Generates a strict architecture contract that defines:
 * - All files that will be generated
 * - Type ownership and exports
 * - Allowed cross-file imports
 * - Build order (dependency ordering)
 *
 * This contract prevents files from inventing undeclared cross-file types.
 */

import { createLogger } from './logger.js';
import type {
  NormalizedSpec,
  ArchitectureContract,
  FileContract,
  ArchitectureStyle,
} from './types.js';

const log = createLogger('builder-v2:architecture-contract');

export class ArchitectureContractGenerator {
  generate(spec: NormalizedSpec): ArchitectureContract {
    const style = this.selectArchitectureStyle(spec);
    const files = this.planFiles(spec, style);
    const contract: ArchitectureContract = {
      appName: spec.appName,
      platform: spec.platform,
      complexity: spec.complexity,
      architectureStyle: style,
      files,
      entryPoint: this.findEntryPoint(spec.platform, files),
      typeOwnershipRules: this.defineTypeOwnership(spec.platform),
      buildConfig: this.defineBuildConfig(spec.platform, spec.appName),
    };

    log.info(
      {
        appName: spec.appName,
        fileCount: files.length,
        style,
        entryPoint: contract.entryPoint,
      },
      'Architecture contract generated',
    );

    return contract;
  }

  private selectArchitectureStyle(spec: NormalizedSpec): ArchitectureStyle {
    // For iOS, prefer MVVM with SwiftUI
    if (spec.platform === 'ios') return 'mvvm';

    // For web, prefer modular/component-based
    if (spec.platform === 'web') return 'modular';

    // For Node/Python, prefer layered
    if (spec.platform === 'node' || spec.platform === 'python')
      return 'layered';

    return 'modular';
  }

  private planFiles(spec: NormalizedSpec, style: ArchitectureStyle): FileContract[] {
    const files: FileContract[] = [];
    let priority = 0;

    if (spec.platform === 'ios') {
      // iOS/SwiftUI structure
      if (spec.complexity === 'simple') {
        files.push(
          this.createFileContract(
            'ContentView.swift',
            'swift',
            'Main view',
            ['ContentView'],
            [],
            priority++,
          ),
        );
        files.push(
          this.createFileContract(
            'MyApp.swift',
            'swift',
            'App entry point',
            ['MyApp'],
            ['ContentView.swift'],
            priority++,
          ),
        );
      } else if (spec.complexity === 'medium') {
        // Model
        files.push(
          this.createFileContract(
            'Models.swift',
            'swift',
            'Data models',
            ['AppData', 'Item'],
            [],
            priority++,
          ),
        );
        // ViewModel
        files.push(
          this.createFileContract(
            'ViewModel.swift',
            'swift',
            'Business logic',
            ['ViewModel'],
            ['Models.swift'],
            priority++,
          ),
        );
        // Views
        files.push(
          this.createFileContract(
            'ContentView.swift',
            'swift',
            'Main view',
            ['ContentView'],
            ['Models.swift', 'ViewModel.swift'],
            priority++,
          ),
        );
        files.push(
          this.createFileContract(
            'MyApp.swift',
            'swift',
            'App entry point',
            ['MyApp'],
            ['ContentView.swift'],
            priority++,
          ),
        );
      } else {
        // complex: add more files for modularity
        files.push(
          this.createFileContract(
            'Models/AppData.swift',
            'swift',
            'Data models',
            ['AppData'],
            [],
            priority++,
          ),
        );
        files.push(
          this.createFileContract(
            'ViewModels/MainViewModel.swift',
            'swift',
            'Main view model',
            ['MainViewModel'],
            ['Models/AppData.swift'],
            priority++,
          ),
        );
        files.push(
          this.createFileContract(
            'Views/ContentView.swift',
            'swift',
            'Main view',
            ['ContentView'],
            ['Models/AppData.swift', 'ViewModels/MainViewModel.swift'],
            priority++,
          ),
        );
        files.push(
          this.createFileContract(
            'Views/DetailsView.swift',
            'swift',
            'Details view',
            ['DetailsView'],
            ['Models/AppData.swift', 'ViewModels/MainViewModel.swift'],
            priority++,
          ),
        );
        files.push(
          this.createFileContract(
            'MyApp.swift',
            'swift',
            'App entry point',
            ['MyApp'],
            ['Views/ContentView.swift'],
            priority++,
          ),
        );
      }
    } else if (spec.platform === 'web') {
      // React/TypeScript structure
      if (spec.complexity === 'simple') {
        files.push(
          this.createFileContract(
            'src/App.tsx',
            'typescript',
            'Root app component',
            ['App'],
            [],
            priority++,
          ),
        );
        files.push(
          this.createFileContract(
            'src/main.tsx',
            'typescript',
            'Entry point',
            [],
            ['App'],
            priority++,
          ),
        );
      } else {
        files.push(
          this.createFileContract(
            'src/types/index.ts',
            'typescript',
            'Type definitions',
            ['AppState', 'Item'],
            [],
            priority++,
          ),
        );
        files.push(
          this.createFileContract(
            'src/hooks/useApp.ts',
            'typescript',
            'App state hook',
            ['useApp'],
            ['types/index.ts'],
            priority++,
          ),
        );
        files.push(
          this.createFileContract(
            'src/components/App.tsx',
            'typescript',
            'Root component',
            ['App'],
            ['types/index.ts', 'hooks/useApp.ts'],
            priority++,
          ),
        );
        files.push(
          this.createFileContract(
            'src/main.tsx',
            'typescript',
            'Entry point',
            [],
            ['components/App.tsx'],
            priority++,
          ),
        );
      }
    } else if (spec.platform === 'python') {
      // Python structure
      files.push(
        this.createFileContract(
          'main.py',
          'python',
          'Application entry point',
          [],
          [],
          priority++,
        ),
      );
      if (spec.complexity !== 'simple') {
        files.push(
          this.createFileContract(
            'models.py',
            'python',
            'Data models',
            [],
            [],
            priority++,
          ),
        );
      }
    } else {
      // Generic/Node fallback
      files.push(
        this.createFileContract(
          'index.js',
          'javascript',
          'Entry point',
          [],
          [],
          priority++,
        ),
      );
    }

    return files;
  }

  private createFileContract(
    filePath: string,
    language: string,
    responsibility: string,
    exportedTypeNames: string[],
    allowedImports: string[],
    priority: number,
  ): FileContract {
    return {
      filePath,
      language,
      responsibility,
      exportedTypes: exportedTypeNames.map((name) => ({
        name,
        kind: 'type', // simplified; actual kind would be inferred during generation
        ownerModule: filePath,
        dependencies: [],
      })),
      allowedImports,
      priority,
    };
  }

  private findEntryPoint(
    platform: string,
    files: FileContract[],
  ): string {
    // iOS: MyApp.swift
    if (platform === 'ios')
      return files.find((f) => f.filePath.endsWith('MyApp.swift'))?.filePath || files[files.length - 1]!.filePath;

    // Web: main.tsx or index.js
    if (platform === 'web')
      return (
        files.find((f) => f.filePath.endsWith('main.tsx') || f.filePath.endsWith('index.js'))?.filePath ||
        files[files.length - 1]!.filePath
      );

    // Python: main.py
    if (platform === 'python') return 'main.py';

    return files[files.length - 1]!.filePath;
  }

  private defineTypeOwnership(platform: string): Record<string, string> {
    const rules: Record<string, string> = {};

    if (platform === 'ios') {
      rules['View'] = 'Views/**/*.swift';
      rules['ViewModel'] = 'ViewModels/**/*.swift';
      rules['Model'] = 'Models/**/*.swift';
    } else if (platform === 'web') {
      rules['Component'] = 'src/components/**/*.tsx';
      rules['Hook'] = 'src/hooks/**/*.ts';
      rules['Type'] = 'src/types/**/*.ts';
      rules['Utility'] = 'src/utils/**/*.ts';
    } else if (platform === 'python') {
      rules['Model'] = 'models.py';
      rules['Service'] = 'services/**/*.py';
      rules['Utility'] = 'utils/**/*.py';
    }

    return rules;
  }

  private defineBuildConfig(platform: string, appName: string): string[] {
    const configs: string[] = [];

    if (platform === 'ios') {
      configs.push('Project.xcodeproj/project.pbxproj');
      configs.push(`${appName}.xcodeproj/project.pbxproj`);
    } else if (platform === 'web') {
      configs.push('package.json');
      configs.push('tsconfig.json');
      configs.push('vite.config.ts');
    } else if (platform === 'python') {
      configs.push('requirements.txt');
      configs.push('pyproject.toml');
    } else if (platform === 'node') {
      configs.push('package.json');
      configs.push('tsconfig.json');
    }

    return configs;
  }
}
