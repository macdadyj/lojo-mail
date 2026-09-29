interface ImportMetaEnv {
  /** API origin for production builds, e.g. the API Gateway URL. Empty means same origin. */
  readonly VITE_LOJO_API_URL?: string;
  /** Origin that serves presigned attachment downloads. Defaults to the us-east-1 S3 virtual-hosted origin. */
  readonly VITE_LOJO_BLOB_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
