/**
 * SIL-534 publishing types. A bundle is the exact set of file changes taken
 * from the job's workspace after the human approved its diff hash. It is
 * saved before any GitHub write, so a failed publish can resume from it even
 * after the job's sprite is gone.
 */

export type GitFileMode = "100644" | "100755";

export type BundleFile =
  | {
      action: "upsert";
      path: string;
      mode: GitFileMode;
      /** File content, base64. */
      contentBase64: string;
      /** `git hash-object` of the content, computed in the sprite; GitHub's blob sha must match. */
      blobSha: string;
    }
  | { action: "delete"; path: string };

export interface PublishBundle {
  /** The approved diff hash this bundle was taken for. */
  diffHash: string;
  baseSha: string;
  baseBranch: string;
  branchName: string;
  files: BundleFile[];
  createdAt: string;
}

export interface PublishResult {
  branch: string;
  commitSha: string;
  treeSha: string;
  prNumber: number;
  prUrl: string;
  /** The PR state when Shipfig finished (a reused PR may already be closed). */
  prState: string;
  draft: boolean;
  /** What already existed on GitHub from an earlier attempt and was reused. */
  reused: { commit: boolean; pullRequest: boolean };
  /** Whether the base branch moved after the job pinned its base commit. */
  baseMoved: boolean;
  publishedAt: string;
}
