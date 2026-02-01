export { CredentialManager, redactSecrets, type CredentialKey } from './keychain.js';
export { ShellSandbox, type ShellPermissionLevel, type ShellSandboxConfig, type ShellResult } from './sandbox.js';
export { DataEncryption, EncryptedColumnHelper } from './encryption.js';
export { AuditLogger, type AuditAction, type AuditEntry, type AuditQueryOptions } from './audit.js';
export { LocalAuth, type AuthResult } from './auth.js';
export { DataManager, type DataExport, type DeleteResult, type PlatformStats } from './data.js';
export { PermissionManager, type PermissionType, type PermissionGrant } from './permissions.js';
