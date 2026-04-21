/**
 * Minimal ZIP reader — just enough to pull the first file entry out of an
 * OpenSubtitles archive.
 *
 * Supports STORED (method 0) and DEFLATE (method 8), which is what
 * opensubtitles.org serves. No encryption, no ZIP64, no multi-volume.
 */

const LOCAL_FILE_HEADER_SIG = 0x04034b50;

/** Read a little-endian uint at offset. */
function u32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)) +
    bytes[offset + 3] * 0x01000000
  );
}
function u16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

async function inflateRaw(input: Uint8Array): Promise<Uint8Array> {
  // Wrap in Blob via ArrayBuffer copy so TS doesn't widen to SharedArrayBuffer.
  const copy = input.slice().buffer;
  const blob = new Blob([copy]);
  const stream = blob.stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export type ZipEntry = {
  name: string;
  data: Uint8Array;
};

/** Extract the first (and typically only) file entry from a single-file ZIP. */
export async function extractFirstEntry(archive: Uint8Array): Promise<ZipEntry> {
  if (archive.length < 30 || u32(archive, 0) !== LOCAL_FILE_HEADER_SIG) {
    throw new Error("Not a ZIP archive (missing local file header signature)");
  }
  const method = u16(archive, 8);
  const compressedSize = u32(archive, 18);
  const nameLen = u16(archive, 26);
  const extraLen = u16(archive, 28);
  const nameStart = 30;
  const name = new TextDecoder().decode(archive.subarray(nameStart, nameStart + nameLen));
  const dataStart = nameStart + nameLen + extraLen;
  const dataEnd = dataStart + compressedSize;
  const compressed = archive.subarray(dataStart, dataEnd);

  let data: Uint8Array;
  if (method === 0) {
    data = compressed;
  } else if (method === 8) {
    data = await inflateRaw(compressed);
  } else {
    throw new Error(`Unsupported ZIP compression method ${method}`);
  }
  return { name, data };
}

/** Decode the first entry of a ZIP archive as UTF-8 / latin1 text. */
export async function extractFirstEntryAsText(archive: Uint8Array): Promise<string> {
  const { data } = await extractFirstEntry(archive);
  // OpenSubtitles uploads are a mix of UTF-8, latin1, and Windows-1252.
  // Try UTF-8 strict first; fall back to latin1 on error so non-ASCII
  // punctuation (apostrophes, em-dashes) at least comes out readable.
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return new TextDecoder("latin1").decode(data);
  }
}
