// Remove a test-owned directory, retrying EAGAIN (virtio-fs returns it on rmdir under load on the Kata CI
// runners). Use these by default for every temp directory a test or script removes.
export {
  removeDirectory as removeTempDirectory,
  removeDirectorySync as removeTempDirectorySync,
} from "../../../scripts/lib/directory-cleanup.mjs"
