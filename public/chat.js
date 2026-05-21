/**
 * LLM Chat App Frontend - Multi-Session Architecture
 */

const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");

const historyButton = document.getElementById("history-button");
const newChatButton = document.getElementById("new-chat-button");
const historyModal = document.getElementById("history-modal");
const closeHistory = document.getElementById("close-history");
const historyLogBody = document.getElementById("history-log-body");

const SESSIONS_STORAGE_KEY = "cf_ai_chat_sessions_v1";
const CURRENT_ID_STORAGE_KEY = "cf_ai_chat_current_id_v1";
const DEFAULT_WELCOME = "Hello! I'm an LLM chat app powered by Cloudflare Workers AI. How can I help you today?";

let chatSessions = JSON.parse(localStorage.getItem(SESSIONS_STORAGE_KEY)) || [];
let currentSessionId = localStorage.getItem(CURRENT_ID_STORAGE_KEY) || null;
let isProcessing = false;

function getCurrentSession() {
	return chatSessions.find(s => s.id === currentSessionId);
}

function createNewSession() {
	const newId = "session_" + Date.now();
	const newSession = {
		id: newId,
		title: "New Chat Session",
		timestamp: new Date().toLocaleDateString(),
		history: [{ role: "assistant", content: DEFAULT_WELCOME }]
	};
	chatSessions.unshift(newSession);
	currentSessionId = newId;
	saveState();
	renderCurrentChat();
}

function saveState() {
	localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(chatSessions));
	localStorage.setItem(CURRENT_ID_STORAGE_KEY, currentSessionId);
}

function renderCurrentChat() {
	const existingMsgs = chatMessages.querySelectorAll(".message");
	existingMsgs.forEach(el => el.remove());

	const session = getCurrentSession();
	if (!session) return;

	session.history.forEach(msg => {
		if (msg.role !== "system") {
			addMessageToChatUi(msg.role, msg.content);
		}
	});
}

userInput.addEventListener("input", function () {
	this.style.height = "auto";
	this.style.height = this.scrollHeight + "px";
});

userInput.addEventListener("keydown", function (e) {
	if (e.key === "Enter" && !e.shiftKey) {
		e.preventDefault();
		sendMessage();
	}
});

sendButton.addEventListener("click", sendMessage);

newChatButton.addEventListener("click", () => {
	const current = getCurrentSession();
	if (current && current.history.length <= 1) {
		alert("You are already in a clean new chat window.");
		return;
	}
	createNewSession();
});

historyButton.addEventListener("click", () => {
	historyLogBody.innerHTML = "";

	if (chatSessions.length === 0) {
		historyLogBody.innerHTML = `<p style="color: var(--text-light); text-align:center; padding:1rem;">No past chat rooms recorded.</p>`;
	} else {
		chatSessions.forEach(session => {
			const item = document.createElement("div");
			item.className = "history-session-item";
			item.innerHTML = `
				<div class="session-title">${escapeHtml(session.title)}</div>
				<div class="session-date">${session.timestamp}</div>
			`;
			
			item.addEventListener("click", () => {
				currentSessionId = session.id;
				saveState();
				renderCurrentChat();
				historyModal.classList.remove("active");
			});
			historyLogBody.appendChild(item);
		});
	}
	historyModal.classList.add("active");
});

closeHistory.addEventListener("click", () => historyModal.classList.remove("active"));
window.addEventListener("click", (e) => { if (e.target === historyModal) historyModal.classList.remove("active"); });

async function sendMessage() {
	const message = userInput.value.trim();
	if (message === "" || isProcessing) return;

	let session = getCurrentSession();
	if (!session) {
		createNewSession();
		session = getCurrentSession();
	}

	isProcessing = true;
	userInput.disabled = true;
	sendButton.disabled = true;

	addMessageToChatUi("user", message);
	session.history.push({ role: "user", content: message });

	if (session.title === "New Chat Session" || session.history.length <= 3) {
		session.title = message.length > 30 ? message.substring(0, 30) + "..." : message;
	}
	saveState();

	userInput.value = "";
	userInput.style.height = "auto";
	typingIndicator.classList.add("visible");
	scrollToBottom();

	let responseText = "";
	let assistantTextEl = null;

	try {
		const response = await fetch("/api/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ messages: session.history }),
		});

		if (!response.ok) throw new Error("Failed response state.");
		if (!response.body) throw new Error("Null response stream.");

		typingIndicator.classList.remove("visible");

		// Clean elements insertion fix preventing trailing empty white gaps
		const assistantMessageEl = document.createElement("div");
		assistantMessageEl.className = "message assistant-message";
		const pEl = document.createElement("p");
		assistantMessageEl.appendChild(pEl);
		chatMessages.insertBefore(assistantMessageEl, typingIndicator);
		assistantTextEl = pEl;

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		const processEvents = (events) => {
			for (const data of events) {
				if (data === "[DONE]") return true;
				try {
					const jsonData = JSON.parse(data);
					const content = jsonData.response || jsonData.choices?.[0]?.delta?.content || "";
					if (content) {
						responseText += content;
						assistantTextEl.textContent = responseText; 
						scrollToBottom();
					}
				} catch (e) {
					console.error("SSE parse error", e);
				}
			}
			return false;
		};

		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				const parsed = consumeSseEvents(buffer + "\n\n");
				processEvents(parsed.events);
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			const parsed = consumeSseEvents(buffer);
			buffer = parsed.buffer;
			if (processEvents(parsed.events)) break;
		}

		if (responseText.trim().length > 0) {
			session.history.push({ role: "assistant", content: responseText });
			saveState();
		}

	} catch (error) {
		console.error("Chat Execution Error:", error);
		typingIndicator.classList.remove("visible");
		addMessageToChatUi("assistant", "Sorry, there was an error processing your request.");
	} final {
		isProcessing = false;
		userInput.disabled = false;
		sendButton.disabled = false;
		userInput.focus();
	}
}

function addMessageToChatUi(role, content) {
	const messageEl = document.createElement("div");
	messageEl.className = `message ${role}-message`;
	const pEl = document.createElement("p");
	pEl.textContent = content;
	messageEl.appendChild(pEl);
	
	chatMessages.insertBefore(messageEl, typingIndicator);
	scrollToBottom();
}

function scrollToBottom() {
	chatMessages.scrollTop = chatMessages.scrollHeight;
}

function consumeSseEvents(buffer) {
	let normalized = buffer.replace(/\r/g, "");
	const events = [];
	let eventEndIndex;
	while ((eventEndIndex = normalized.indexOf("\n\n")) !== -1) {
		const rawEvent = normalized.slice(0, eventEndIndex);
		normalized = normalized.slice(eventEndIndex + 2);
		const lines = rawEvent.split("\n");
		const dataLines = [];
		for (const line of lines) {
			if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
		}
		if (dataLines.length === 0) continue;
		events.push(dataLines.join("\n"));
	}
	return { events, buffer: normalized };
}

function escapeHtml(str) {
	return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

if (!currentSessionId || !getCurrentSession()) {
	if (chatSessions.length > 0) {
		currentSessionId = chatSessions[0].id;
	} else {
		createNewSession();
	}
}
saveState();
renderCurrentChat();
