const path = require('node:path');

function configureTestWindows(BrowserWindow, appRoot, visible = false) {
  const originalShow = BrowserWindow.prototype.show;
  BrowserWindow.prototype.show = visible ? function () {
    this.setTitle('Neo-Hoard acceptance - synthetic');
    return originalShow.call(this);
  } : function () {};
  const originalLoadFile = BrowserWindow.prototype.loadFile;
  BrowserWindow.prototype.loadFile = function (file, options) {
    if (visible) {
      this.on('page-title-updated', event => event.preventDefault());
      this.setTitle('Neo-Hoard acceptance - synthetic');
    } else this.hide();
    return originalLoadFile.call(this, path.resolve(appRoot, file), options);
  };
}

module.exports = { configureTestWindows };
