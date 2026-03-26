import imageCompression from "browser-image-compression";

/** Skip client-side compression at or below this size (bytes). */
export const COMPRESS_SKIP_BELOW_BYTES = 1024 * 1024;

const MAX_LONG_EDGE = 1600;
const RETRIES_PER_PROFILE = 2;

const COMPRESSION_PROFILES = [
	{
		maxSizeMB: 1,
		maxWidthOrHeight: MAX_LONG_EDGE,
		initialQuality: 0.85,
		useWebWorker: true,
	},
	{
		maxSizeMB: 0.85,
		maxWidthOrHeight: MAX_LONG_EDGE,
		initialQuality: 0.72,
		useWebWorker: true,
	},
	{
		maxSizeMB: 0.75,
		maxWidthOrHeight: 1400,
		initialQuality: 0.6,
		useWebWorker: false,
	},
] as const;

export function formatBytes(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	if (bytes < COMPRESS_SKIP_BELOW_BYTES) {
		const kb = bytes / 1024;
		return kb < 10 ? `${kb.toFixed(1)} KB` : `${Math.round(kb)} KB`;
	}
	return `${(bytes / COMPRESS_SKIP_BELOW_BYTES).toFixed(1)} MB`;
}

function stripExtension(name: string): string {
	const i = name.lastIndexOf(".");
	return i === -1 ? name : name.slice(0, i);
}

export type CompressImageResult = {
	file: File;
	originalName: string;
	/** e.g. "5.2 MB → 820 KB" or "820 KB (already under 1 MB)" */
	sizeSummary: string;
	skipped: boolean;
};

function toWebpFile(blob: File, originalName: string): File {
	const base = stripExtension(originalName) || "image";
	return new File([blob], `${base}.webp`, {
		type: blob.type || "image/webp",
		lastModified: Date.now(),
	});
}

async function compressWithProfile(
	file: File,
	profile: (typeof COMPRESSION_PROFILES)[number],
): Promise<File> {
	const compressed = await imageCompression(file, {
		maxSizeMB: profile.maxSizeMB,
		maxWidthOrHeight: profile.maxWidthOrHeight,
		useWebWorker: profile.useWebWorker,
		fileType: "image/webp",
		initialQuality: profile.initialQuality,
	});
	return toWebpFile(compressed, file.name);
}

async function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Compress large images to WebP (max long edge 1600px, target under 1 MB).
 * Skips when file is already under 1 MB or not an image/* type.
 * Retries each profile with backoff, then falls back to more aggressive settings.
 */
export async function compressImageForUpload(
	file: File,
): Promise<CompressImageResult> {
	const originalName = file.name;
	const beforeBytes = file.size;

	if (!file.type.startsWith("image/")) {
		return {
			file,
			originalName,
			sizeSummary: `${formatBytes(beforeBytes)} (not an image)`,
			skipped: true,
		};
	}

	if (beforeBytes < COMPRESS_SKIP_BELOW_BYTES) {
		return {
			file,
			originalName,
			sizeSummary: `${formatBytes(beforeBytes)} (already under 1 MB)`,
			skipped: true,
		};
	}

	let lastError: unknown;

	for (const profile of COMPRESSION_PROFILES) {
		for (let attempt = 1; attempt <= RETRIES_PER_PROFILE; attempt++) {
			try {
				const out = await compressWithProfile(file, profile);
				const afterBytes = out.size;
				return {
					file: out,
					originalName,
					sizeSummary: `${formatBytes(beforeBytes)} → ${formatBytes(afterBytes)}`,
					skipped: false,
				};
			} catch (error) {
				lastError = error;
				if (attempt < RETRIES_PER_PROFILE) {
					await sleep(120 * attempt);
				}
			}
		}
	}

	const message =
		lastError instanceof Error
			? lastError.message
			: "Image compression failed after retries";
	throw new Error(message);
}

export async function compressImagesForUpload(
	files: File[],
	onProgress?: (info: {
		index: number;
		total: number;
		message: string;
	}) => void,
): Promise<CompressImageResult[]> {
	const results: CompressImageResult[] = [];
	for (let i = 0; i < files.length; i++) {
		const file = files[i];
		if (!file) continue;
		const result = await compressImageForUpload(file);
		results.push(result);
		onProgress?.({
			index: i + 1,
			total: files.length,
			message: result.sizeSummary,
		});
	}
	return results;
}
