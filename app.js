const SUPABASE_URL = "https://zspsyaxqgfoyklhlerza.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_rAQtxQxq6c30Bow7mCId4w_IFWYEPsV";
const SUPABASE_READY = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY && window.supabase);

const DEFAULT_SERVERS = [
  {
    id: "general",
    name: "General",
    description: "A casual room for everyone.",
    topic: "Open chat",
  },
  {
    id: "design",
    name: "Design",
    description: "Talk about UI, layout, and product ideas.",
    topic: "Creative chat",
  },
  {
    id: "code",
    name: "Code",
    description: "Share code, tips, and debugging ideas.",
    topic: "Technical chat",
  },
];

const STORAGE_KEYS = {
  profile: "simple-chat.profile",
  server: "simple-chat.server",
  messages: "simple-chat.messages",
  rooms: "simple-chat.rooms",
  randomPresence: "simple-chat.random.presence",
};

class Store {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  set(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  remove(key) {
    localStorage.removeItem(key);
  }
}

class AppState {
  constructor(store) {
    this.store = store;
    this.profile = this.store.get(STORAGE_KEYS.profile, null);
    this.currentServer = this.store.get(STORAGE_KEYS.server, null);
    this.activeMode = null;
    this.activeRoomId = null;
    this.messages = this.store.get(STORAGE_KEYS.messages, {});
    this.rooms = this.store.get(STORAGE_KEYS.rooms, {});
  }

  saveProfile(profile) {
    this.profile = profile;
    this.store.set(STORAGE_KEYS.profile, profile);
  }

  saveServer(serverId) {
    this.currentServer = serverId;
    if (serverId) {
      this.store.set(STORAGE_KEYS.server, serverId);
    } else {
      this.store.remove(STORAGE_KEYS.server);
    }
  }

  saveMessages(roomId, messages) {
    this.messages[roomId] = messages;
    this.store.set(STORAGE_KEYS.messages, this.messages);
  }

  saveRoom(roomId, room) {
    this.rooms[roomId] = room;
    this.store.set(STORAGE_KEYS.rooms, this.rooms);
  }

  removeRoom(roomId) {
    delete this.rooms[roomId];
    delete this.messages[roomId];
    this.store.set(STORAGE_KEYS.rooms, this.rooms);
    this.store.set(STORAGE_KEYS.messages, this.messages);
  }

}

class ChatRoom {
  constructor(app, type, roomId, label) {
    this.app = app;
    this.type = type;
    this.roomId = roomId;
    this.label = label;
    this.isConnected = false;
    this.partnerName = null;
    this.channel = new BroadcastChannel(`simple-chat:${roomId}`);
    this.presenceKey = STORAGE_KEYS.randomPresence;
    this.presenceTimer = null;
    this.onStorageChange = this.onStorageChange.bind(this);
    this.onChannelMessage = this.onChannelMessage.bind(this);
    this.channel.addEventListener("message", this.onChannelMessage);
  }

  get messages() {
    return this.app.state.messages[this.roomId] || [];
  }

  set messages(value) {
    this.app.state.saveMessages(this.roomId, value);
  }

  connect() {
    this.isConnected = true;
    this.appendSystemMessage(`Joined ${this.label}.`);
    if (this.type === "random") {
      this.markPresence();
      this.presenceTimer = window.setInterval(() => this.markPresence(), 3000);
      window.addEventListener("storage", this.onStorageChange);
      this.announceJoin();
      this.subscribeToRealtimeMessages();
    } else if (this.type === "server" && SUPABASE_READY) {
      this.subscribeToRealtimeMessages();
    }
    this.updateStatus();
  }

  subscribeToRealtimeMessages() {
    if (!SUPABASE_READY || !window.supabaseClient) return;
    
    try {
      const channel = window.supabaseClient.channel(`chat:${this.roomId}`);
      channel
        .on("broadcast", { event: "message" }, (payload) => {
          if (payload.payload?.mine) {
            const incoming = {
              ...payload.payload,
              mine: false,
              sender: (payload.payload.sender?.trim() || "Guest"),
            };
            this.pushMessage(incoming);
          }
        })
        .subscribe();
      
      this.realtimeChannel = channel;
    } catch (error) {
      console.log("Realtime subscription skipped", error.message);
    }
  }

  close() {
    if (this.presenceTimer) {
      window.clearInterval(this.presenceTimer);
      this.presenceTimer = null;
    }
    if (this.type === "random") {
      this.clearPresence();
      window.removeEventListener("storage", this.onStorageChange);
    }
    if (this.realtimeChannel) {
      this.realtimeChannel.unsubscribe();
      this.realtimeChannel = null;
    }
    this.channel.removeEventListener("message", this.onChannelMessage);
    this.channel.close();
  }

  send(text) {
    const message = this.createMessage(text, true);
    this.pushMessage(message);
    this.channel.postMessage({ type: "message", payload: message });
    this.sendRealtimeMessage(message);
    this.updateStatus();
  }

  sendRealtimeMessage(message) {
    if (!SUPABASE_READY || !this.realtimeChannel) return;
    
    try {
      this.realtimeChannel.send({
        type: "broadcast",
        event: "message",
        payload: message,
      });
    } catch (error) {
      console.log("Realtime send skipped", error.message);
    }
  }

  createMessage(text, mine = false, sender = null) {
    if (!sender) {
      const profileName = this.app.state.profile?.name;
      const trimmed = profileName?.trim();
      sender = trimmed || "Guest";
      console.log("createMessage debug:", { profileName, trimmed, sender, profile: this.app.state.profile });
    }
    return {
      id: crypto.randomUUID(),
      text,
      sender: sender?.trim() || "Guest",
      mine,
      createdAt: new Date().toISOString(),
    };
  }

  pushMessage(message) {
    const next = [...this.messages, message];
    this.messages = next;
    this.app.renderMessages(next);
  }

  appendSystemMessage(text) {
    this.pushMessage({
      id: crypto.randomUUID(),
      text,
      sender: "System",
      mine: false,
      system: true,
      createdAt: new Date().toISOString(),
    });
  }

  onChannelMessage(event) {
    const { type, payload } = event.data || {};
    if (type === "message" && payload?.mine) {
      const incoming = {
        ...payload,
        mine: false,
        sender: (payload.sender?.trim() || "Guest"),
      };
      this.pushMessage(incoming);
    }

    if (type === "connect") {
      this.partnerName = (payload?.name?.trim() || "Someone");
      this.isConnected = true;
      this.appendSystemMessage(`${this.partnerName} joined the room.`);
      this.updateStatus();
    }

    if (type === "leave") {
      this.partnerName = null;
      this.isConnected = false;
      this.appendSystemMessage(`${(payload?.name?.trim() || "Someone")} left the room.`);
      this.updateStatus();
    }
  }

  onStorageChange(event) {
    if (event.key === this.presenceKey) {
      this.updateStatus();
    }
  }

  getPresence() {
    return this.app.store.get(this.presenceKey, {});
  }

  setPresence(presence) {
    this.app.store.set(this.presenceKey, presence);
  }

  markPresence() {
    const presence = this.getPresence();
    const displayName = this.app.state.profile?.name?.trim() || "Guest";
    presence[this.app.sessionId()] = {
      name: displayName,
      joinedAt: Date.now(),
      lastSeen: Date.now(),
    };
    this.setPresence(presence);
  }

  clearPresence() {
    const presence = this.getPresence();
    delete presence[this.app.sessionId()];
    this.setPresence(presence);
  }

  randomPresenceCount() {
    const presence = this.getPresence();
    const now = Date.now();
    const active = Object.entries(presence).filter(([, entry]) => now - entry.lastSeen < 7000);
    if (active.length !== Object.keys(presence).length) {
      this.setPresence(Object.fromEntries(active));
    }
    return active.length;
  }

  updateStatus() {
    if (this.type === "random") {
      const activeCount = this.randomPresenceCount();
      if (activeCount > 1) {
        this.app.setStatus("Someone joined the random chat.", "ok");
        this.app.setChatTitle("Random chat active");
      } else {
        this.app.setStatus("Waiting for another person to join.", "warn");
        this.app.setChatTitle("Waiting for someone to join...");
      }
      return;
    }

    this.app.setStatus(`In ${this.label}.`, "ok");
    this.app.setChatTitle(this.label);
  }

  announceJoin() {
    const displayName = this.app.state.profile?.name?.trim() || "Guest";
    this.channel.postMessage({
      type: "connect",
      payload: { name: displayName },
    });
  }

  announceLeave() {
    const displayName = this.app.state.profile?.name?.trim() || "Guest";
    this.channel.postMessage({
      type: "leave",
      payload: { name: displayName },
    });
  }
}

class ChatApp {
  constructor() {
    this.store = new Store();
    this.state = new AppState(this.store);
    this.currentRoom = null;
    this.pendingSupabaseUser = null;
    this.rateLimitCooldown = 0;
    this.rateLimitTimer = null;
    this.serverCatalog = [
      ...DEFAULT_SERVERS,
      {
        id: "music",
        name: "Music",
        description: "Share songs and recommendations.",
        topic: "Listening room",
      },
    ];

    this.cacheElements();
    this.bindEvents();
    this.renderServers();
    this.initApp();
  }

  initApp() {
    if (SUPABASE_READY && window.supabaseClient) {
      this.checkSupabaseAuth();
    } else {
      this.restoreSession();
    }
  }

  async checkSupabaseAuth() {
    try {
      const { data: { user } } = await window.supabaseClient.auth.getUser();
      if (user && user.user_metadata?.display_name) {
        const displayName = user.user_metadata.display_name;
        this.setProfile({ name: displayName, provider: "supabase" });
        this.showLobby();
        this.setStatus("Signed in via Supabase.", "ok");
      } else {
        this.restoreSession();
      }
    } catch (error) {
      this.restoreSession();
    }
  }

  cacheElements() {
    this.statusText = document.getElementById("statusText");
    this.statusDot = document.getElementById("statusDot");
    this.authView = document.getElementById("authView");
    this.lobbyView = document.getElementById("lobbyView");
    this.chatView = document.getElementById("chatView");
    this.nameEntryView = document.getElementById("nameEntryView");
    this.guestName = document.getElementById("guestName");
    this.guestContinue = document.getElementById("guestContinue");
    this.authEmail = document.getElementById("authEmail");
    this.authPassword = document.getElementById("authPassword");
    this.signUpBtn = document.getElementById("signUpBtn");
    this.signInBtn = document.getElementById("signInBtn");
    this.signOutBtn = document.getElementById("signOutBtn");
    this.welcomeTitle = document.getElementById("welcomeTitle");
    this.welcomeSubtitle = document.getElementById("welcomeSubtitle");
    this.randomChatBtn = document.getElementById("randomChatBtn");
    this.serversBtn = document.getElementById("serversBtn");
    this.serverList = document.getElementById("serverList");
    this.chatModeLabel = document.getElementById("chatModeLabel");
    this.chatTitle = document.getElementById("chatTitle");
    this.messageList = document.getElementById("messageList");
    this.messageInput = document.getElementById("messageInput");
    this.sendMessageBtn = document.getElementById("sendMessageBtn");
    this.leaveChatBtn = document.getElementById("leaveChatBtn");
    this.navUserName = document.getElementById("navUserName");
    this.navHomeBtn = document.getElementById("navHomeBtn");
    this.nameInput = document.getElementById("nameInput");
    this.confirmNameBtn = document.getElementById("confirmNameBtn");
  }

  bindEvents() {
    this.guestContinue.addEventListener("click", () => this.joinAsGuest());
    this.signUpBtn.addEventListener("click", () => this.signUpWithSupabase());
    this.signInBtn.addEventListener("click", () => this.signInWithSupabase());
    this.confirmNameBtn.addEventListener("click", () => this.confirmName());
    this.signOutBtn.addEventListener("click", () => this.reset());
    this.randomChatBtn.addEventListener("click", () => this.enterRandomChat());
    this.serversBtn.addEventListener("click", () => this.showLobby());
    this.sendMessageBtn.addEventListener("click", () => this.sendMessage());
    this.leaveChatBtn.addEventListener("click", () => this.leaveRoom());
    this.navHomeBtn.addEventListener("click", () => this.leaveRoom());
    this.messageInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        this.sendMessage();
      }
    });
    this.nameInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        this.confirmName();
      }
    });
  }

  restoreSession() {
    if (this.state.profile) {
      this.setProfile(this.state.profile);
      this.showLobby();
      const mode = this.state.profile.provider === "supabase" ? "Supabase" : "Guest";
      this.setStatus(`${mode} mode. Ready to chat.`, "ok");
      return;
    }

    this.showAuth();
    if (SUPABASE_READY) {
      this.setStatus("Create a Supabase account for cross-browser chat, or continue as guest (browser-only).", "warn");
    } else {
      this.setStatus("Guest mode available (browser-only).", "warn");
    }
  }

  renderServers() {
    this.serverList.innerHTML = "";
    this.serverList.append(...this.serverListTemplate());
  }

  serverListTemplate() {
    return this.serverListData().map((server) => {
      const row = document.createElement("article");
      row.className = "server-item";

      const details = document.createElement("div");
      const title = document.createElement("h3");
      title.textContent = server.name;
      const text = document.createElement("p");
      text.textContent = `${server.description} · ${server.topic}`;
      details.append(title, text);

      const button = document.createElement("button");
      button.className = "secondary";
      button.textContent = "Join";
      button.addEventListener("click", () => this.joinServer(server));

      row.append(details, button);
      return row;
    });
  }

  serverListData() {
    return this.serverCatalog;
  }

  showAuth() {
    this.toggleViews("auth");
    this.updateWelcome();
  }

  showLobby() {
    this.toggleViews("lobby");
    this.updateWelcome();
    this.clearRoom();
  }

  toggleViews(view) {
    this.authView.classList.toggle("active", view === "auth");
    this.lobbyView.classList.toggle("active", view === "lobby");
    this.chatView.classList.toggle("active", view === "chat");
    this.nameEntryView.classList.toggle("active", view === "name-entry");
    this.navHomeBtn.style.display = view === "chat" ? "block" : "none";
  }

  updateWelcome() {
    const name = this.state.profile?.name?.trim() || "Guest";
    this.welcomeTitle.textContent = `Welcome, ${name}`;
    this.welcomeSubtitle.textContent = this.state.profile?.provider === "supabase"
      ? "Your Supabase account is connected."
      : "Pick a chat mode to start talking.";
    this.updateNavBar();
  }

  updateNavBar() {
    if (this.state.profile) {
      const name = this.state.profile?.name?.trim() || "User";
      this.navUserName.textContent = name;
      this.navHomeBtn.style.display = "block";
    } else {
      this.navUserName.textContent = "Simple Chat";
      this.navHomeBtn.style.display = "none";
    }
  }

  setProfile(profile) {
    this.state.saveProfile(profile);
    this.updateWelcome();
  }

  joinAsGuest() {
    const name = this.guestName.value.trim();
    if (!name) {
      this.setStatus("Add a display name to continue.", "error");
      this.guestName.focus();
      return;
    }

    this.setProfile({ name, provider: "guest" });
    this.showLobby();
    this.setStatus(`Signed in as ${name} (browser-only mode).`, "warn");
  }

  async signUpWithSupabase() {
    if (this.rateLimitCooldown > 0) {
      this.setStatus(`Please wait ${this.rateLimitCooldown} seconds before trying again.`, "error");
      return;
    }

    const email = this.authEmail.value.trim();
    const password = this.authPassword.value.trim();

    if (!SUPABASE_READY) {
      this.setStatus("Add your Supabase project URL and anon key in app.js first.", "error");
      return;
    }

    if (!email || !password) {
      this.setStatus("Enter both email and password.", "error");
      return;
    }

    this.disableAuthButtons(true);
    try {
      const { data, error } = await window.supabaseClient.auth.signUp({ email, password });
      if (error) throw error;
      
      this.setStatus("Account created. Now choose your display name.", "ok");
      this.pendingSupabaseUser = { email, password, userId: data.user?.id };
      this.nameInput.value = "";
      this.nameInput.focus();
      this.toggleViews("name-entry");
      this.disableAuthButtons(false);
    } catch (error) {
      const message = this.getErrorMessage(error);
      this.setStatus(message, "error");
      if (this.isRateLimitError(error)) {
        this.startRateLimitCooldown();
      } else {
        this.disableAuthButtons(false);
      }
    }
  }

  async signInWithSupabase() {
    if (this.rateLimitCooldown > 0) {
      this.setStatus(`Please wait ${this.rateLimitCooldown} seconds before trying again.`, "error");
      return;
    }

    const email = this.authEmail.value.trim();
    const password = this.authPassword.value.trim();

    if (!SUPABASE_READY) {
      this.setStatus("Add your Supabase project URL and anon key in app.js first.", "error");
      return;
    }

    if (!email || !password) {
      this.setStatus("Enter both email and password.", "error");
      return;
    }

    this.disableAuthButtons(true);
    try {
      const { data, error } = await window.supabaseClient.auth.signInWithPassword({ email, password });
      if (error) throw error;
      
      const user = data.user;
      const displayName = user.user_metadata?.display_name;
      
      if (displayName) {
        this.setProfile({ name: displayName, provider: "supabase" });
        this.showLobby();
        this.setStatus(`Signed in as ${displayName}.`, "ok");
        this.disableAuthButtons(false);
      } else {
        this.setStatus("Signed in. Now choose your display name.", "ok");
        this.pendingSupabaseUser = { email, userId: user.id };
        this.nameInput.value = "";
        this.nameInput.focus();
        this.toggleViews("name-entry");
        this.disableAuthButtons(false);
      }
    } catch (error) {
      const message = this.getErrorMessage(error);
      this.setStatus(message, "error");
      if (this.isRateLimitError(error)) {
        this.startRateLimitCooldown();
      } else {
        this.disableAuthButtons(false);
      }
    }
  }

  isRateLimitError(error) {
    const msg = error?.message?.toLowerCase() || "";
    return msg.includes("rate limit") || msg.includes("too many requests");
  }

  startRateLimitCooldown(seconds = 60) {
    this.rateLimitCooldown = seconds;
    this.disableAuthButtons(true);
    
    if (this.rateLimitTimer) {
      clearInterval(this.rateLimitTimer);
    }

    this.updateCooldownDisplay();
    this.rateLimitTimer = setInterval(() => {
      this.rateLimitCooldown--;
      this.updateCooldownDisplay();
      
      if (this.rateLimitCooldown <= 0) {
        clearInterval(this.rateLimitTimer);
        this.rateLimitTimer = null;
        this.disableAuthButtons(false);
        this.setStatus("You can try again now.", "ok");
      }
    }, 1000);
  }

  updateCooldownDisplay() {
    if (this.rateLimitCooldown > 0) {
      this.setStatus(`Rate limited. Please wait ${this.rateLimitCooldown} seconds.`, "warn");
    }
  }

  disableAuthButtons(disabled) {
    this.signUpBtn.disabled = disabled;
    this.signInBtn.disabled = disabled;
    this.guestContinue.disabled = disabled;
    if (disabled) {
      this.signUpBtn.style.opacity = "0.5";
      this.signInBtn.style.opacity = "0.5";
      this.guestContinue.style.opacity = "0.5";
    } else {
      this.signUpBtn.style.opacity = "1";
      this.signInBtn.style.opacity = "1";
      this.guestContinue.style.opacity = "1";
    }
  }

  getErrorMessage(error) {
    const msg = error?.message?.toLowerCase() || "";
    
    if (msg.includes("rate limit") || msg.includes("too many requests")) {
      return "Too many attempts. Please wait a few minutes before trying again.";
    }
    if (msg.includes("invalid login credentials") || msg.includes("invalid email or password")) {
      return "Invalid email or password.";
    }
    if (msg.includes("user already exists") || msg.includes("user_already_exists")) {
      return "Email already registered. Try signing in instead.";
    }
    if (msg.includes("weak password")) {
      return "Password is too weak. Use at least 8 characters.";
    }
    if (msg.includes("invalid email")) {
      return "Please enter a valid email address.";
    }
    
    return error.message || "Authentication failed. Please try again.";
  }

  async confirmName() {
    const name = this.nameInput.value.trim();
    if (!name) {
      this.setStatus("Enter a display name.", "error");
      this.nameInput.focus();
      return;
    }

    if (!this.pendingSupabaseUser) {
      this.setStatus("No pending user.", "error");
      return;
    }

    try {
      // Check if we have an active session. If not, sign in first.
      let { data: { user: currentUser } } = await window.supabaseClient.auth.getUser();
      
      if (!currentUser && this.pendingSupabaseUser.email && this.pendingSupabaseUser.password) {
        // No active session, sign in with stored credentials
        const { error: signInError } = await window.supabaseClient.auth.signInWithPassword({
          email: this.pendingSupabaseUser.email,
          password: this.pendingSupabaseUser.password
        });
        if (signInError) throw signInError;
        
        // Get the user after signing in
        const { data: { user } } = await window.supabaseClient.auth.getUser();
        currentUser = user;
      }
      
      if (!currentUser) {
        throw new Error("Unable to establish session.");
      }
      
      const { error } = await window.supabaseClient.auth.updateUser({
        data: { display_name: name }
      });
      if (error) throw error;
      
      this.setProfile({ name, provider: "supabase" });
      console.log("confirmName success:", { name, profile: this.state.profile });
      this.pendingSupabaseUser = null;
      this.showLobby();
      this.setStatus(`Welcome, ${name}!`, "ok");
    } catch (error) {
      const message = this.getErrorMessage(error);
      this.setStatus(message, "error");
    }
  }

  joinServer(server) {
    this.state.saveServer(server.id);
    this.openRoom("server", server.id, server.name, server.description);
  }

  enterRandomChat() {
    this.openRoom("random", "random-lobby", "Random chat", "Random chat");
    this.currentRoom.appendSystemMessage("Waiting for someone to join.");
    this.currentRoom.updateStatus();
  }

  openRoom(type, roomId, label, description) {
    this.clearRoom();
    this.toggleViews("chat");
    this.currentRoom = new ChatRoom(this, type, roomId, label);
    console.log("openRoom debug:", { type, label, profile: this.state.profile });
    this.state.activeMode = type;
    this.state.activeRoomId = roomId;
    this.chatModeLabel.textContent = description;
    this.chatTitle.textContent = label;
    this.messageList.innerHTML = "";
    this.renderMessages(this.state.messages[roomId] || []);
    this.currentRoom.connect();
    if (type === "server") {
      this.currentRoom.appendSystemMessage(`You joined ${label}.`);
    }
    this.messageInput.focus();
    if (type === "random") {
      this.currentRoom.updateStatus();
    }
    if (type === "server") {
      this.setStatus(`Joined ${label}.`, "ok");
    }
  }

  clearRoom() {
    if (this.currentRoom) {
      this.currentRoom.announceLeave();
      this.currentRoom.close();
      this.currentRoom = null;
    }
  }

  leaveRoom() {
    this.clearRoom();
    this.state.activeRoomId = null;
    this.state.activeMode = null;
    this.showAuth();
    this.setStatus("Returned home.", "warn");
  }

  sendMessage() {
    const text = this.messageInput.value.trim();
    if (!text) {
      return;
    }

    if (!this.currentRoom) {
      this.setStatus("Join a room before sending messages.", "error");
      return;
    }

    this.currentRoom.send(text);
    this.messageInput.value = "";
  }

  renderMessages(messages) {
    this.messageList.innerHTML = "";
    if (!messages.length) {
      const empty = document.createElement("div");
      empty.className = "message";
      empty.innerHTML = "<p>No messages yet. Start the conversation.</p>";
      this.messageList.append(empty);
      return;
    }

    for (const message of messages) {
      const bubble = document.createElement("article");
      bubble.className = `message ${message.mine ? "mine" : ""}`.trim();
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.innerHTML = `<span>${message.sender || "Guest"}</span><span>${this.formatTime(message.createdAt)}</span>`;
      const text = document.createElement("p");
      text.textContent = message.text;
      bubble.append(meta, text);
      this.messageList.append(bubble);
    }

    this.messageList.scrollTop = this.messageList.scrollHeight;
  }

  formatTime(value) {
    return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  setStatus(text, tone = "ok") {
    this.statusText.textContent = text;
    this.statusDot.classList.remove("ok", "warn", "error");
    this.statusDot.classList.add(tone);
  }

  goHome() {
    this.leaveRoom();
  }

  setChatTitle(text) {
    this.chatTitle.textContent = text;
  }

  reset() {
    if (this.rateLimitTimer) {
      clearInterval(this.rateLimitTimer);
      this.rateLimitTimer = null;
    }
    this.rateLimitCooldown = 0;
    this.clearRoom();
    this.state.saveProfile(null);
    this.state.saveServer(null);
    this.pendingSupabaseUser = null;
    if (this.state.activeRoomId) {
      this.state.saveMessages(this.state.activeRoomId, []);
    }
    this.messageList.innerHTML = "";
    this.authEmail.value = "";
    this.authPassword.value = "";
    this.guestName.value = "";
    this.nameInput.value = "";
    this.disableAuthButtons(false);
    this.showAuth();
    this.setStatus("Session cleared.", "warn");
  }

  sessionId() {
    if (!this._sessionId) {
      this._sessionId = crypto.randomUUID();
    }
    return this._sessionId;
  }
}

function createSupabaseClient() {
  if (!SUPABASE_READY) {
    return null;
  }

  window.supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return window.supabaseClient;
}

createSupabaseClient();
window.addEventListener("DOMContentLoaded", () => {
  window.chatApp = new ChatApp();
});
