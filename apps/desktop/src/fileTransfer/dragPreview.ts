// Native drag-rs uses the image's intrinsic size. Keep this independent of
// the application's 512 px icon so the OS drag image stays small on both OSes.
import { fileType, type FileMeta } from "./fileTypes.ts";
export async function dragPreview(
  paths: string[],
  meta?: FileMeta,
): Promise<number[]> {
  const c = document.createElement("canvas");
  c.width = 48;
  c.height = 56;
  const x = c.getContext("2d")!;
  const img = new Image();
  img.src = fileType(paths[0] ?? "", meta).icon;
  await img.decode();
  x.drawImage(img, 3, 3, 40, 42);
  x.textAlign = "center";
  if (paths.length > 1) {
    x.fillStyle = "#56664d";
    x.beginPath();
    x.arc(37, 43, 10, 0, Math.PI * 2);
    x.fill();
    x.fillStyle = "white";
    x.font = "bold 10px sans-serif";
    x.fillText(paths.length > 99 ? "99+" : String(paths.length), 37, 46);
  }
  const blob = await new Promise<Blob>((resolve, reject) =>
    c.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("preview"))),
      "image/png",
    ),
  );
  return Array.from(new Uint8Array(await blob.arrayBuffer()));
}
