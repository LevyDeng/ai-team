class CompletionNotifications {
  constructor({store, busy, render, changed, attention}) {
    Object.assign(this, {store, busy, render, changed, attention});
  }
  refresh() {
    const count = this.store.state.chats.filter(chat => chat.unread && !this.busy(chat.id)).length;
    this.render(count);
    return count;
  }
  complete(chatId) {
    // Only the owner of the submitted task may announce completion.
    if (this.busy(chatId)) return false;
    this.store.get('chats', chatId).unread = true;
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
