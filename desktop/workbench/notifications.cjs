const workflowNotificationStatuses = new Set(['complete', 'needs_check', 'unavailable', 'round_limit', 'unresolved']);

class CompletionNotifications {
  constructor({store, busy, render, changed, attention}) {
    Object.assign(this, {store, busy, render, changed, attention});
  }
  refresh() {
    const count = this.store.state.chats.filter(chat =>
      chat.unread && !this.busy(chat.id) && !['queued', 'running'].includes(chat.workflow?.status)
    ).length;
    this.render(count);
    return count;
  }
  complete(chatId, {workflow = false} = {}) {
    // Only the owner of the submitted task may announce completion.
    if (this.busy(chatId)) return false;
    const chat = this.store.get('chats', chatId);
    if (workflow !== Boolean(chat.workflow) || (workflow && !workflowNotificationStatuses.has(chat.workflow.status))) return false;
    chat.unread = true;
    this.store.scheduleSave();
    this.changed();
    this.refresh();
    this.attention();
    return true;
  }
  read(chatId) {
    const chat=this.store.get('chats', chatId);
    if(chat.unread){
      chat.unread = false;
      this.store.save();
      this.changed();
    }
    this.refresh();
  }
}
module.exports = {CompletionNotifications};
