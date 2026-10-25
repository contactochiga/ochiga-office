// Product gallery (Phase 2 stage 3): image validation and processing (catalogue-media.js) and the gallery rules of the content model.
// Every fixture is generated here; nothing is downloaded.
"use strict";
const zlib = require("zlib");
const sharp = require("sharp");
const M = require("../src/lead-agents/catalogue-media");
const C = require("../src/lead-agents/catalogue");

let checks = 0, failures = 0;
const check = (id, text, cond, detail) => { checks += 1; if (!cond) failures += 1; console.log(`${cond ? "PASS" : "FAIL"} ${id} ${text}${cond ? "" : " :: " + String(JSON.stringify(detail === undefined ? null : detail)).slice(0, 500)}`); };
const code = async (fn) => { try { await fn(); return "accepted"; } catch (error) { return error.code || error.message; } };

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n += 1) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
// a structurally valid PNG header that claims huge dimensions (decompression-bomb shape) with almost no data
function pngClaiming(width, height) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", ihdr), pngChunk("IDAT", zlib.deflateSync(Buffer.alloc(64))), pngChunk("IEND", Buffer.alloc(0))]);
}

async function main() {
  const solid = (w, h, bg = "#c8102e") => sharp({ create: { width: w, height: h, channels: 3, background: bg } });
  const jpegWithGps = await solid(1200, 800).withExif({ IFD0: { Copyright: "fixture-owner", Artist: "fixture-artist" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "6/1 27/1 0/1" } }).jpeg({ quality: 85 }).toBuffer();
  const png = await solid(900, 900, "#1f2937").png().toBuffer();
  const webp = await solid(640, 480, "#16a34a").webp().toBuffer();
  const rotated = await solid(1000, 400).withMetadata({ orientation: 6 }).jpeg().toBuffer();

  // --- signatures (content, never the declared type)
  check("MD01", "content signature: JPEG / PNG / WebP recognised from the bytes", M.sniffImage(jpegWithGps) === "jpeg" && M.sniffImage(png) === "png" && M.sniffImage(webp) === "webp");
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)" width="400" height="400"><rect width="400" height="400"/></svg>');
  const html = Buffer.from("<!doctype html><script>alert(1)</script>".padEnd(200, " "));
  const gif = await solid(300, 300).gif().toBuffer();
  const tiff = await solid(300, 300).tiff().toBuffer();
  const avif = await solid(300, 300).avif().toBuffer().catch(() => null);
  const results = {
    svg: await code(() => M.processProductImage(svg)), html: await code(() => M.processProductImage(html)), gif: await code(() => M.processProductImage(gif)),
    tiff: await code(() => M.processProductImage(tiff)), avif: avif ? await code(() => M.processProductImage(avif)) : "unsupported_image_type",
    pdf: await code(() => M.processProductImage(Buffer.from("%PDF-1.7\n".padEnd(400, "x")))),
  };
  check("MD02", "SVG, HTML, GIF, TIFF, AVIF and PDF are refused by content (415 unsupported_image_type)", Object.values(results).every((r) => r === "unsupported_image_type"), results);

  // --- malformed / polyglot / mislabelled
  const polyglot = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("<html><script>alert(1)</script></html>".padEnd(400, " "))]);
  const truncated = jpegWithGps.subarray(0, Math.floor(jpegWithGps.length / 2));
  const pngBody = Buffer.concat([png.subarray(0, 8), Buffer.from("garbage-instead-of-chunks".repeat(20))]);
  const riffNotWebp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 "), Buffer.alloc(200, 7)]);
  const mal = {
    polyglot: await code(() => M.processProductImage(polyglot)), truncated: await code(() => M.processProductImage(truncated)),
    pngBody: await code(() => M.processProductImage(pngBody)), riff: await code(() => M.processProductImage(riffNotWebp)),
    empty: await code(() => M.processProductImage(Buffer.alloc(0))), tiny: await code(() => M.processProductImage(Buffer.from([0xff, 0xd8, 0xff]))),
  };
  check("MD03", "a JPEG-signature polyglot, a truncated JPEG, a corrupt PNG and a fake WebP are refused (422 image_unreadable); empty is 400",
    mal.polyglot === "image_unreadable" && mal.truncated === "image_unreadable" && mal.pngBody === "image_unreadable" && mal.riff === "image_unreadable" && mal.empty === "image_empty" && mal.tiny === "unsupported_image_type", mal);

  // --- limits
  const bomb = await code(() => M.processProductImage(pngClaiming(50000, 50000)));
  check("MD04", "a PNG header claiming 50000x50000 px (decompression bomb) is refused before any decode", bomb === "image_too_many_pixels" || bomb === "image_dimensions_too_large", bomb);
  const wide = await code(async () => M.processProductImage(await solid(8200, 300).png({ compressionLevel: 9 }).toBuffer()));
  const small = await code(async () => M.processProductImage(await solid(150, 600).png().toBuffer()));
  check("MD05", "dimension limits: wider than 8000 px refused, narrower than 200 px refused", wide === "image_dimensions_too_large" && small === "image_dimensions_too_small", { wide, small });
  const huge = Buffer.concat([jpegWithGps, Buffer.alloc(M.MEDIA_LIMITS.maxBytes)]);
  check("MD06", "file size limit: more than 15 MB refused (413 image_too_large)", (await code(() => M.processProductImage(huge))) === "image_too_large");
  const frame = await solid(300, 300).png().toBuffer();
  const animated = await sharp([frame, await solid(300, 300, "#000").png().toBuffer()], { join: { animated: true } }).webp().toBuffer().catch(() => null);
  check("MD07", "an animated (multi-frame) WebP is refused (422 image_animated)", animated && (await code(() => M.processProductImage(animated))) === "image_animated", animated ? "" : "fixture not generated");

  // --- processing
  const out = await M.processProductImage(jpegWithGps);
  const metas = await Promise.all(out.derivatives.map((d) => sharp(d.buffer).metadata()));
  check("MD08", "a valid JPEG yields four WebP renditions (thumb 320, 480, 960, 1600 box) without enlargement",
    out.format === "jpeg" && out.derivatives.map((d) => d.kind).join() === "thumb,w480,w960,w1600" && metas.every((x) => x.format === "webp")
      && out.derivatives[0].width === 320 && out.derivatives[2].width === 960 && out.derivatives[3].width === 1200, out.derivatives.map((d) => [d.kind, d.width, d.height]));
  const inMeta = await sharp(jpegWithGps).metadata();
  check("MD09", "metadata stripping: the upload carried EXIF (incl. GPS); no rendition carries EXIF, XMP, IPTC or an ICC profile",
    Boolean(inMeta.exif) && metas.every((x) => !x.exif && !x.xmp && !x.iptc && !x.icc), metas.map((x) => ({ exif: Boolean(x.exif), icc: Boolean(x.icc) })));
  check("MD10", "renditions do not contain the uploaded EXIF strings", out.derivatives.every((d) => !d.buffer.includes(Buffer.from("fixture-owner")) && !d.buffer.includes(Buffer.from("fixture-artist"))));
  const rot = await M.processProductImage(rotated);
  check("MD11", "EXIF orientation is applied: a 1000x400 image tagged orientation 6 is recorded and rendered as 400x1000", rot.width === 400 && rot.height === 1000 && rot.derivatives[3].height === 1000 && rot.derivatives[3].width === 400, [rot.width, rot.height, rot.derivatives[3].width, rot.derivatives[3].height]);
  const pngOut = await M.processProductImage(png), webpOut = await M.processProductImage(webp);
  check("MD12", "PNG and WebP accepted; sha256 is the hash of the exact upload", pngOut.format === "png" && webpOut.format === "webp" && pngOut.sha256 === M.sha256(png) && /^[0-9a-f]{64}$/.test(webpOut.derivatives[0].sha256));
  const named = M.safeOriginalName('../../etc/<script>"x".jpg\u0000');
  check("MD13", "original file names are reduced to plain text (no path, markup or control characters)", !/[<>"\\/\u0000]/.test(named) && named.length <= 200, named);

  // --- concurrency limit
  const burst = await Promise.all(Array.from({ length: 12 }, () => code(() => M.processProductImage(png))));
  check("MD14", "processing is serialised with a bounded queue: a burst of 12 completes 7 (1 + queue 6) and refuses the rest with media_busy",
    burst.filter((r) => r === "accepted").length === 7 && burst.filter((r) => r === "media_busy").length === 5, burst);

  // --- content model: gallery rules
  const ids = Array.from({ length: 13 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
  const base = { category_id: ids[0], name: "Hub", variants: [{ sku: "HUB-1", name: "White" }, { sku: "HUB-2", name: "Black" }] };
  const errs = (content) => { try { C.validateContent(content); return []; } catch (error) { return error.details || [error.message]; } };
  check("MG01", "an incomplete draft is valid: no images at all", errs(base).length === 0);
  const twoCovers = errs({ ...base, media: [{ media_id: ids[1], cover: true }, { media_id: ids[2], cover: true }] });
  const noCover = errs({ ...base, media: [{ media_id: ids[1] }] });
  check("MG02", "exactly one cover once there is any image (none / two refused)", twoCovers.some((e) => /exactly one image/.test(e)) && noCover.some((e) => /exactly one image/.test(e)));
  check("MG03", "at most 12 images", errs({ ...base, media: ids.slice(0, 13).map((id, i) => ({ media_id: id, cover: i === 0 })) }).some((e) => /at most 12/.test(e))
    && errs({ ...base, media: ids.slice(0, 12).map((id, i) => ({ media_id: id, cover: i === 0 })) }).length === 0);
  check("MG04", "the same image twice, a non-id and an unknown variant are refused",
    errs({ ...base, media: [{ media_id: ids[1], cover: true }, { media_id: ids[1] }] }).some((e) => /twice/.test(e))
    && errs({ ...base, media: [{ media_id: "../x", cover: true }] }).some((e) => /image id/.test(e))
    && errs({ ...base, media: [{ media_id: ids[1], cover: true, variant_skus: ["HUB-9"] }] }).some((e) => /not a variant/.test(e)));
  const normal = C.validateContent({ ...base, media: [{ media_id: ids[1].toUpperCase(), cover: true, alt: "  Front view ", caption: "x", variant_skus: ["hub-2", "HUB-2"], extra: "dropped" }] });
  check("MG05", "an image reference is normalised to {media_id, cover, alt, caption, variant_skus} (ids lowercased, SKUs upper-cased and de-duplicated, unknown keys dropped)",
    JSON.stringify(normal.media) === JSON.stringify([{ media_id: ids[1], cover: true, alt: "Front view", caption: "x", variant_skus: ["HUB-2"] }]), normal.media);
  check("MG06", "alt text and caption length limits", errs({ ...base, media: [{ media_id: ids[1], cover: true, alt: "a".repeat(251) }] }).length === 1 && errs({ ...base, media: [{ media_id: ids[1], cover: true, caption: "a".repeat(301) }] }).length === 1);
  const r0 = C.galleryReadiness({ media: [] });
  const r1 = C.galleryReadiness({ media: [{ media_id: ids[1], cover: true, alt: "" }, { media_id: ids[2], cover: false, alt: "Side" }] });
  const r2 = C.galleryReadiness({ media: [{ media_id: ids[1], cover: true, alt: "Front" }] });
  check("MG07", "public readiness: needs a cover and alt text on every image (reported, not enforced, for drafts)",
    !r0.ready_for_public && r0.issues.includes("no_images") && !r1.ready_for_public && r1.missing_alt === 1 && r2.ready_for_public && r2.below_recommended && r2.cover_media_id === ids[1]);
  const diff = C.diffContent({ media: [{ media_id: ids[1], cover: true, alt: "" }, { media_id: ids[2], cover: false, alt: "" }] }, { media: [{ media_id: ids[2], cover: false, alt: "" }, { media_id: ids[1], cover: true, alt: "Front" }] });
  check("MG08", "version diff lists gallery changes per image (alt changed) and the new order", diff.some((d) => d.field === `media[${ids[1]}]`) && diff.some((d) => d.field === "media.order"), diff);
  const card = C.productCard({ id: "p", slug: "p" }, { name: "Hub", media: [{ media_id: ids[2], cover: false }, { media_id: ids[1], cover: true }] }, []);
  check("MG09", "catalogue table card carries the cover image id and image count", card.cover_media_id === ids[1] && card.image_count === 2);
  check("MG10", "documents are still refused", errs({ ...base, documents: [{ x: 1 }] }).some((e) => /documents/.test(e)));

  console.log(`\n${checks - failures}/${checks} passed`);
  process.exit(failures ? 1 : 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
