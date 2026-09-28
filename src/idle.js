// Pomocník: malé okienka (bubliny, menu, návrhy) po zatvorení chvíľu počkajú a potom sa úplne zrušia,
// aby ich proces (≈ 50–90 MB každé) neostal zbytočne v pamäti. Pri ďalšom otvorení sa vytvoria znova.
function releaseWhenIdle(owner, ms) {
  clearTimeout(owner._idleTimer);
  owner._idleTimer = setTimeout(() => {
    if (owner.visible || !owner.view) return;
    const wc = owner.view.webContents;
    owner.view = null;
    owner.ready = null;
    if (!wc.isDestroyed()) wc.close();
  }, ms);
}
function keepAlive(owner) { clearTimeout(owner._idleTimer); }

module.exports = { releaseWhenIdle, keepAlive };
