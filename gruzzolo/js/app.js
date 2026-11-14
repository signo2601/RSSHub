// App-level hooks shared by every module. main.js replaces these no-ops at boot,
// so views can trigger a render or open a sheet without importing main.js.
export const app = {
  render() {},
  toast(_message) {},
  pushSheet(_name, _args) {},
  popSheet() {},
  closeSheets() {},
  renderSheet() {},
  askConfirm(_opts) {},
  async refreshPrices(_opts) {},
};
