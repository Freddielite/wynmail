// Very small user agent sorting for tracking: enough to ignore robots and split phones from desktops.
// Nothing here stores the raw user agent or the IP address.
export function classifyUa(ua = '') {
  const u = String(ua).toLowerCase();
  if (!u) return { device: 'unknown', proxy: false };
  if (/bot|crawler|spider|preview|scanner|curl\/|wget|python|headless|http-client|okhttp|go-http|java\//.test(u)) return { device: 'bot', proxy: false };
  const proxy = /googleimageproxy|ggpht|yahoomailproxy|outlookimageproxy/.test(u);
  let device = 'unknown';
  if (/ipad|tablet/.test(u)) device = 'tablet';
  else if (/mobi|iphone|android/.test(u)) device = 'mobile';
  else if (/windows|macintosh|linux|cros/.test(u)) device = 'desktop';
  return { device, proxy };
}
