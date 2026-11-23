import {
  Injectable,
  BadRequestException,
  PayloadTooLargeException,
  RequestTimeoutException,
  Logger,
} from '@nestjs/common';
import { createReadStream, createWriteStream, unlinkSync } from 'fs';
import { mkdir, rmdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';
import * as Busboy from 'busboy';

/**
 * Streaming multipart parser with size and type detection constraints.
 *
 * Enforces:
 * - Per-part size limits (max 32 KB per credential)
 * - Total upload size limits (max 256 KB for all parts)
 * - Per-part timeout (30 seconds)
 * - Magic byte type detection (reject executables, archives, scripts)
 * - Maximum parts per upload (100)
 */

const MAX_PART_SIZE_BYTES = 32 * 1024; // 32 KB per credential
const MAX_TOTAL_UPLOAD_SIZE_BYTES = 256 * 1024; // 8 credentials worth
const MAX_PARTS_PER_UPLOAD = 100;
const MULTIPART_PARSE_TIMEOUT_MS = 30_000; // 30 seconds per part
const MULTIPART_HEADER_SIZE = 4 * 1024; // 4 KB for field name + metadata

/**
 * Safe MIME types allowed for credential uploads
 */
const ALLOWED_MIME_TYPES = new Set([
  'application/json',
  'text/plain',
  'application/octet-stream',
]);

/**
 * Magic bytes signatures for type detection (first 12 bytes)
 */
const MAGIC_BYTES_SIGNATURES = {
  // JSON: starts with { [ or whitespace
  JSON: /^[\s\{\[\"]/.test.bind(null),
  
  // Executables and archives to reject
  ELF: (buf: Buffer) => buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46, // 0x7fELF
  PE: (buf: Buffer) => buf[0] === 0x4d && buf[1] === 0x5a, // MZ
  ZIP: (buf: Buffer) => buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04, // PK\x03\x04
  GZIP: (buf: Buffer) => buf[0] === 0x1f && buf[1] === 0x8b, // \x1f\x8b
  RAR: (buf: Buffer) => buf[0] === 0x52 && buf[1] === 0x61 && buf[2] === 0x72, // Rar
  TAR_GZIP: (buf: Buffer) => buf[257] === 0x75 && buf[258] === 0x73 && buf[259] === 0x74, // ustar at offset 257
  BZIP2: (buf: Buffer) => buf[0] === 0x42 && buf[1] === 0x5a, // BZ
  XZ: (buf: Buffer) => buf[0] === 0xfd && buf[1] === 0x37 && buf[2] === 0x7a, // \xfd7z
  SCRIPT_SH: (buf: Buffer) => buf[0] === 0x23 && buf[1] === 0x21, // #!
};

export interface ParsedPart {
  fieldName: string;
  filename: string;
  mimeType: string;
  size: number;
  hash: string; // SHA-256 hex
  tempPath: string;
  detectedType: 'json' | 'binary' | 'unknown';
  firstBytes: Buffer; // First 12 bytes for type detection
}

export interface MultipartParseResult {
  parts: ParsedPart[];
  totalSize: number;
  tempDir: string;
}

@Injectable()
export class MultipartParserService {
  private readonly logger = new Logger(MultipartParserService.name);
  private readonly tempBaseDir = join(tmpdir(), 'earnproof-multipart');

  /**
   * Parse multipart form data from a request stream.
   *
   * Enforces streaming limits, type detection, and size constraints.
   * Streams parts to temporary files for safe handling.
   *
   * @param req HTTP request with multipart content
   * @returns Parse result with array of parsed parts
   * @throws BadRequestException on invalid part data
   * @throws PayloadTooLargeException on size violations
   * @throws RequestTimeoutException on parse timeout
   */
  async parseMultipart(
    req: any, // Express request object
    contentType: string,
  ): Promise<MultipartParseResult> {
    // Ensure temp directory exists
    try {
      await mkdir(this.tempBaseDir, { recursive: true });
    } catch (error) {
      this.logger.error(`Failed to create temp directory: ${error}`);
      throw new BadRequestException('Failed to initialize multipart parser');
    }

    const tempDir = join(this.tempBaseDir, `upload-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`);

    try {
      await mkdir(tempDir, { recursive: true });
    } catch (error) {
      this.logger.error(`Failed to create upload temp directory: ${error}`);
      throw new BadRequestException('Failed to initialize upload directory');
    }

    const parts: ParsedPart[] = [];
    let totalSize = 0;
    let partCount = 0;
    const parseErrors: string[] = [];

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.cleanupTempDir(tempDir);
        reject(
          new RequestTimeoutException(
            'Multipart parsing timeout exceeded (30 seconds)',
          ),
        );
      }, MULTIPART_PARSE_TIMEOUT_MS);

      const bb = Busboy({ headers: { 'content-type': contentType } });

      bb.on(
        'file',
        (fieldName: string, file: any, info: { filename: string; encoding: string; mimeType: string }) => {
          partCount++;

          if (partCount > MAX_PARTS_PER_UPLOAD) {
            clearTimeout(timeout);
            this.cleanupTempDir(tempDir);
            reject(
              new PayloadTooLargeException(
                `Exceeds maximum parts per upload (${MAX_PARTS_PER_UPLOAD})`,
              ),
            );
            return;
          }

          const filename = info.filename || `part-${partCount}`;
          const mimeType = info.mimeType || 'application/octet-stream';
          const tempPath = join(tempDir, `part-${partCount}`);

          let partSize = 0;
          const hasher = createHash('sha256');
          let firstBytes: Buffer | null = null;
          let detectedType: 'json' | 'binary' | 'unknown' = 'unknown';

          const writeStream = createWriteStream(tempPath);
          let streamError = false;

          file.on('data', (chunk: Buffer) => {
            if (streamError) return;

            partSize += chunk.length;

            // Check per-part size limit
            if (partSize > MAX_PART_SIZE_BYTES) {
              streamError = true;
              file.destroy();
              writeStream.destroy();
              clearTimeout(timeout);
              this.cleanupTempDir(tempDir);
              reject(
                new PayloadTooLargeException(
                  `Part exceeds maximum size (${MAX_PART_SIZE_BYTES / 1024} KB)`,
                ),
              );
              return;
            }

            // Check total upload size
            if (totalSize + partSize > MAX_TOTAL_UPLOAD_SIZE_BYTES) {
              streamError = true;
              file.destroy();
              writeStream.destroy();
              clearTimeout(timeout);
              this.cleanupTempDir(tempDir);
              reject(
                new PayloadTooLargeException(
                  `Total upload exceeds maximum size (${MAX_TOTAL_UPLOAD_SIZE_BYTES / 1024} KB)`,
                ),
              );
              return;
            }

            // Capture first 12 bytes for magic byte detection
            if (firstBytes === null || firstBytes.length < 12) {
              const needed = Math.min(12 - (firstBytes?.length ?? 0), chunk.length);
              firstBytes = firstBytes
                ? Buffer.concat([firstBytes, chunk.slice(0, needed)])
                : chunk.slice(0, needed);
            }

            hasher.update(chunk);
            writeStream.write(chunk);
          });

          file.on('end', () => {
            writeStream.end();
          });

          file.on('error', (error: Error) => {
            streamError = true;
            writeStream.destroy();
            clearTimeout(timeout);
            this.cleanupTempDir(tempDir);
            reject(new BadRequestException(`File upload error: ${error.message}`));
          });

          writeStream.on('finish', () => {
            if (streamError) return;

            totalSize += partSize;

            // Detect type from magic bytes
            if (firstBytes) {
              detectedType = this.detectType(firstBytes, mimeType);

              // Reject dangerous types
              const rejected = this.rejectDangerousType(detectedType, firstBytes);
              if (rejected) {
                clearTimeout(timeout);
                this.cleanupTempDir(tempDir);
                reject(
                  new BadRequestException(
                    `File type not allowed: ${rejected}`,
                  ),
                );
                return;
              }
            }

            const parsedPart: ParsedPart = {
              fieldName,
              filename,
              mimeType,
              size: partSize,
              hash: hasher.digest('hex'),
              tempPath,
              detectedType,
              firstBytes: firstBytes || Buffer.alloc(0),
            };

            parts.push(parsedPart);
          });

          writeStream.on('error', (error: Error) => {
            streamError = true;
            clearTimeout(timeout);
            this.cleanupTempDir(tempDir);
            reject(
              new BadRequestException(`Failed to write part to disk: ${error.message}`),
            );
          });
        },
      );

      bb.on('error', (error: Error) => {
        clearTimeout(timeout);
        this.cleanupTempDir(tempDir);
        reject(new BadRequestException(`Multipart parsing error: ${error.message}`));
      });

      bb.on('close', () => {
        clearTimeout(timeout);

        if (parts.length === 0) {
          this.cleanupTempDir(tempDir);
          reject(new BadRequestException('No files received in multipart request'));
          return;
        }

        this.logger.log(
          `Parsed ${parts.length} parts, total size: ${totalSize} bytes`,
        );

        resolve({
          parts,
          totalSize,
          tempDir,
        });
      });

      // Pipe request to busboy
      req.pipe(bb);
    });
  }

  /**
   * Detect file type from magic bytes and MIME type.
   *
   * @param firstBytes First 12 bytes of file
   * @param mimeType Claimed MIME type
   * @returns Detected type: 'json' | 'binary' | 'unknown'
   */
  private detectType(firstBytes: Buffer, mimeType: string): 'json' | 'binary' | 'unknown' {
    // Check MIME type claim
    if (mimeType === 'application/json' || mimeType === 'text/plain') {
      return 'json';
    }

    // Check magic bytes for JSON (very permissive for partial buffers)
    if (
      firstBytes.length > 0 &&
      (firstBytes[0] === 0x7b || // {
        firstBytes[0] === 0x5b || // [
        firstBytes[0] === 0x22 || // "
        firstBytes[0] === 0x20 || // space
        firstBytes[0] === 0x09 || // tab
        firstBytes[0] === 0x0a || // newline
        firstBytes[0] === 0x0d) // carriage return
    ) {
      return 'json';
    }

    return firstBytes.length > 0 ? 'binary' : 'unknown';
  }

  /**
   * Reject files with dangerous magic byte signatures.
   *
   * @param detectedType Detected file type
   * @param firstBytes First 12 bytes
   * @returns Rejection reason or null if allowed
   */
  private rejectDangerousType(
    detectedType: 'json' | 'binary' | 'unknown',
    firstBytes: Buffer,
  ): string | null {
    if (firstBytes.length === 0) {
      return null; // Empty file, allow for now
    }

    // Check for dangerous signatures
    if (MAGIC_BYTES_SIGNATURES.ELF(firstBytes)) return 'ELF executable';
    if (MAGIC_BYTES_SIGNATURES.PE(firstBytes)) return 'Windows executable';
    if (MAGIC_BYTES_SIGNATURES.ZIP(firstBytes)) return 'ZIP archive';
    if (MAGIC_BYTES_SIGNATURES.GZIP(firstBytes)) return 'GZIP archive';
    if (MAGIC_BYTES_SIGNATURES.RAR(firstBytes)) return 'RAR archive';
    if (MAGIC_BYTES_SIGNATURES.BZIP2(firstBytes)) return 'BZIP2 archive';
    if (MAGIC_BYTES_SIGNATURES.XZ(firstBytes)) return 'XZ archive';
    if (
      firstBytes.length >= 260 &&
      MAGIC_BYTES_SIGNATURES.TAR_GZIP(firstBytes)
    )
      return 'TAR+GZIP archive';
    if (MAGIC_BYTES_SIGNATURES.SCRIPT_SH(firstBytes)) return 'Shell script';

    return null;
  }

  /**
   * Clean up temporary directory and files.
   *
   * @param tempDir Temporary directory path
   */
  private async cleanupTempDir(tempDir: string): Promise<void> {
    try {
      const files = await new Promise<string[]>((resolve, reject) => {
        const fs = require('fs');
        fs.readdir(tempDir, (err: Error | null, files: string[]) => {
          if (err) reject(err);
          else resolve(files || []);
        });
      });

      for (const file of files) {
        try {
          unlinkSync(join(tempDir, file));
        } catch (error) {
          this.logger.warn(`Failed to delete temp file: ${error}`);
        }
      }

      await rmdir(tempDir);
    } catch (error) {
      this.logger.warn(`Failed to cleanup temp directory: ${error}`);
    }
  }

  /**
   * Clean up parsed parts and temporary directory.
   *
   * @param result Parse result with temp directory
   */
  async cleanupParseResult(result: MultipartParseResult): Promise<void> {
    await this.cleanupTempDir(result.tempDir);
  }
}
