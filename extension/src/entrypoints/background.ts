export default defineBackground(() => {
  // The toolbar button opens the notebook beside the page.
  if (import.meta.env.FIREFOX) {
    // Firefox-only API, absent from WXT's Chrome-based types.
    const { sidebarAction } = browser as unknown as { sidebarAction: { toggle(): Promise<void> } };
    browser.action.onClicked.addListener(() => sidebarAction.toggle());
  } else {
    void browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  }
});
