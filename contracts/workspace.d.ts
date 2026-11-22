/** Public context v1. SHA256 values identify exact bytes; IDs are opaque. */
export interface WorkspaceContext {
  readonly version: 1;
  readonly revision: number;
  readonly mode: string | null;
  readonly loadState: string | null;
  readonly loading: boolean;
  readonly project: {
    readonly id: string | null;
    readonly repository: string | null;
    readonly branch: string | null;
    readonly sourceCommit: string | null;
  } | null;
  readonly file: {
    readonly path: string | null;
    readonly baseCommit: string | null;
    readonly persistedSha256: string | null;
    readonly currentTextSha256: string | null;
    readonly hashPending: boolean;
    readonly dirty: boolean;
    readonly editable: boolean;
  } | null;
  readonly selection: Readonly<{
    kind: string | null; name: string | null; scope: string | null;
    targetKind: 'canonical' | 'export' | 'unmapped';
    sourcePath: string | null; sourceSha256: string | null;
    lineStart: number | null; lineEnd: number | null;
    viewerSourcePath: string | null; nativeEntryId: string | null;
    mappingVerified: boolean; readonly: boolean;
    occurrencePath: readonly string[] | null; occurrenceResolved: boolean;
    terminalName: string | null; busBit: number | null;
    [additionalMetadata: string]: unknown;
  }> | null;
  readonly geometry: Readonly<{
    sourceMatch: boolean; snapshotOnly: boolean; state: string | null;
    bundleCommit: string | null; manifestSha256: string | null;
    canonicalMappingEnabled: boolean;
    [additionalMetadata: string]: unknown;
  }> | null;
  readonly run: Readonly<{
    runId: string | null; sourceCommit: string | null; state: string | null;
    configurationId: string | null; projectId: string | null;
    sourceSha256: string | null; historical: boolean;
  }> | null;
}

export interface ContextAdapter {
  getContext(): WorkspaceContext;
  subscribe(listener: (context: WorkspaceContext) => void): () => void;
  readSelection(options: {contextRevision: number; maxLines?: number; maxBytes?: number}): Promise<Readonly<{
    contextRevision: number; sourcePath: string; sourceSha256: string;
    targetKind: string; lineStart: number; lineEnd: number; text: string;
    bytes: number; truncated: boolean;
  }>>;
}
