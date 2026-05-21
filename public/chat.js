/**
 * LLM Chat App Frontend with State Persistence
 */

// DOM elements
const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");

// History Modals & Utility Controls
const historyButton = document.getElementById("history-button");
const clearButton = document.getElementById("clear-button");
const historyModal = document.getElementById("history-modal");
const closeHistory = document.getElementById("close-history");
const historyLogBody = document.getElementById("history-log-body");

// Key used to isolate browser local storage allocations
const STORAGE_KEY = "cf_ai_chat_history";

// Initial state setup: Load existing storage array or generate default fallback
let chatHistory = JSON.parse(localStorage.getItem(STORAGE_KEY)) || [
	{
		role: "assistant",
		content: "Hello! I'm an LLM chat app powered by Cloudflare Workers AI. How can I help you today?",
	},
];

let isProcessing = false;

// Initialize app UI state by rendering historical context chunks on page load
function initChatLog() {
	// Remove old message structures but leave typing bubble placeholder safe
	const existingMsgs = chatMessages.querySelectorAll(".message");
	existingMsgs.forEach(el => el.remove());

	chatHistory.forEach(msg => {
		if (msg.role !== "system") {
			addMessageToChat(msg.role, msg.content);
		}
	});
}

// Persist the current chat history state to LocalStorage
function saveToLocalStorage() {
	localStorage.setItem(STORAGE_KEY, JSON.stringify(chatHistory));
}

// Auto-resize textarea as user types
userInput.addEventListener("input", function () {
	this.style.height = "auto";
	this.style.height = this.scrollHeight + "px";
});

// Send message on Enter (without Shift)
userInput.addEventListener("keydown", function (e) {
	if (e.key === "Enter" && !e.shiftKey) {
		e.preventDefault();
		sendMessage();
	}
});

// Button Interactions
sendButton.addEventListener("click", sendMessage);

clearButton.addEventListener("click", () => {
	if (confirm("Are you sure you want to clear your conversation history?")) {
		chatHistory = [
			{
				role: "assistant",
				content: "Hello! I'm an LLM chat app powered by Cloudflare Workers AI. How can I help you today?",
			},
		];
		saveToLocalStorage();
		initChatLog();
	}
});

// Modal Logic
historyButton.addEventListener("click", () => {
	historyLogBody.innerHTML = "";
	// Filter out system configurations from showing up in user dashboard panels
	const visibleLogs = chatHistory.filter(m => m.role !== "system");

	if (visibleLogs.length === 0) {
		historyLogBody.innerHTML = `<p style="color: var(--text-light); text-align:center; padding:1rem;">No conversational logs preserved yet.</p>`;
	} else {
		visibleLogs.forEach(msg => {
			const item = document.createElement("div");
			item.className = "history-item";
			item.innerHTML = `
				<div class="history-role">${msg.role === 'user' ? 'You' : 'AI Assistant'}</div>
				<div>${escapeHtml(msg.content)}</div>
			`;
			historyLogBody.appendChild(item);
		});
	}
	historyModal.classList.add("active");
});

closeHistory.addEventListener("click", () => historyModal.classList.remove("active"));
window.addEventListener("click", (e) => { if (e.target === historyModal) historyModal.classList.remove("active"); });

/**
 * Sends a message to the chat API and processes the response
 */
async function sendMessage() {
	const message = userInput.value.trim();

	if (message === "" || isProcessing) return;

	isProcessing = true;
	userInput.disabled = true;
	sendButton.disabled = true;

	addMessageToChat("user", message);
	chatHistory.push({ role: "user", content: message });
	saveToLocalStorage(); // Persist instantly when user updates content

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
			body: JSON.stringify({ messages: chatHistory }),
		});

		if (!response.ok) throw new Error("Failed to get response from server.");
		if (!response.body) throw new Error("Response body is empty.");

		typingIndicator.classList.remove("visible");

		const assistantMessageEl = document.createElement("div");
		assistantMessageEl.className = "message assistant-message";
		assistantMessageEl.innerHTML = "<p></p>";
		chatMessages.appendChild(assistantMessageEl);
		assistantTextEl = assistantMessageEl.querySelector("p");

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
					console.error("Error parsing SSE JSON data:", e, data);
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

			const shouldStop = processEvents(parsed.events);
			if (shouldStop) break;
		}

		if (responseText.trim().length > 0) {
			chatHistory.push({ role: "assistant", content: responseText });
			saveToLocalStorage(); // Commit assistant response to permanent history storage
		}

	} catch (error) {
		console.error("Chat Error:", error);
		typingIndicator.classList.remove("visible");
		addMessageToChat("assistant", "Sorry, there was an error processing your request.");
	} finally {
		isProcessing = false;
		userInput.disabled = false;
		sendButton.disabled = false;
		userInput.focus();
	}
}

function addMessageToChat(role, content) {
	const messageEl = document.createElement("div");
	messageEl.className = `message ${role}-message`;
	messageEl.innerHTML = `<p></p>`;
	messageEl.querySelector("p").textContent = content; 
	
	// Inject before typing indicator element safely
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
			if (line.startsWith("data:")) {
				dataLines.push(line.slice(5).trimStart());
			}
		}
		if (dataLines.length === 0) continue;
		events.push(dataLines.join("\n"));
	}
	return { events, buffer: normalized };
}

// Quick string escaping utility helper to keep modal outputs pure and safe against script tags
function escapeHtml(str) {
	return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

// Initial state execution pipeline trigger
initChatLog();
