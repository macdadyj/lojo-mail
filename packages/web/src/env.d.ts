interface ImportMetaEnv {
  /** API origin for production builds, e.g. the API Gateway URL. Empty means same origin. */
  readonly VITE_LOJO_API_URL?: string;
  /** Exact mail-bucket origin for presigned attachment downloads (`terraform output -raw web_blob_origin`). Required with VITE_LOJO_API_URL. */
  readonly VITE_LOJO_BLOB_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
