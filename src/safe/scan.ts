// Read a QR code with the camera (an app's WalletConnect code): the browser's own BarcodeDetector where
// there is one, else jsQR (loaded only then). Draws the camera into `box`; resolves on the first code.
export const canScan = () => !!navigator.mediaDevices?.getUserMedia;

export function scan(box: HTMLElement): { done: Promise<string>; stop: () => void } {
  let stream: MediaStream | null = null, live = true, fail: (e: Error) => void = () => {};
  const video = document.createElement("video");
  video.playsInline = true; video.muted = true;
  box.replaceChildren(video);
  const stop = () => { live = false; stream?.getTracks().forEach((t) => t.stop()); video.remove(); fail(new Error("stopped")); };
  const done = new Promise<string>(async (ok, no) => {
    fail = no;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      if (!live) { stream.getTracks().forEach((t) => t.stop()); return; }
      video.srcObject = stream;
      await video.play();
      const BD = (window as any).BarcodeDetector;
      const det = BD ? new BD({ formats: ["qr_code"] }) : null;
      const jsqr = det ? null : (await import("jsqr")).default;
      const c = document.createElement("canvas"), g = c.getContext("2d", { willReadFrequently: true })!;
      while (live) {
        let text = "";
        if (det) text = (await det.detect(video).catch(() => []))[0]?.rawValue || "";
        else if (video.videoWidth) {
          c.width = video.videoWidth; c.height = video.videoHeight;
          g.drawImage(video, 0, 0);
          text = jsqr!(g.getImageData(0, 0, c.width, c.height).data, c.width, c.height)?.data || "";
        }
        if (text) { live = false; stream.getTracks().forEach((t) => t.stop()); ok(text); return; }
        await new Promise((r) => setTimeout(r, 150));
      }
    } catch (e: any) { no(new Error(e?.name === "NotAllowedError" ? "The camera is blocked: allow it, or paste the link." : e?.message || String(e))); }
  });
  return { done, stop };
}
