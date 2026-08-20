// The page's own world. Everything YouTube hangs on #movie_player — loadVideoById among it —
// is invisible from a content script, so the swap has to be made from here.
// Loading a song into the running player is not a navigation: fullscreen, the socket and the
// panel all live through the song change.
addEventListener('kara-play', e => {
  try {
    document.getElementById('movie_player').loadVideoById(e.detail);
  } catch {
    return; // no player yet, or YouTube moved the API: content.js falls back to a normal navigation
  }
  dispatchEvent(new Event('kara-played')); // synchronous — content.js reads the answer right after its own dispatch
});
