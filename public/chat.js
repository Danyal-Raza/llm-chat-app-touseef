/**
 * Consolidated Workspace Engine - Multi-Session LLM Chat + Visual Merge Sorter
 */

// --- TAB ROUTING DOM COUPLINGS ---
const tabChat = document.getElementById("tab-chat");
const tabSorter = document.getElementById("tab-sorter");
const panelChat = document.getElementById("panel-chat");
const panelSorter = document.getElementById("panel-sorter");

// --- CHAT DOM CORE ELEMENTS ---
const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");
const historyButton = document.getElementById("history-button");
const newChatButton = document.getElementById("new-chat-button");
const historyModal = document.getElementById("history-modal");
const closeHistory = document.getElementById("close-history");
const historyLogBody = document.getElementById("history-log-body");

// --- SORTING DOM CORE ELEMENTS ---
const arrayInput = document.getElementById('array-input');
const loadBtn = document.getElementById('load-btn');
const prevBtn = document.getElementById('prev-btn');
const nextBtn = document.getElementById('next-btn');
const resetSorterBtn = document.getElementById('reset-sorter-btn');
const barStage = document.getElementById('bar-stage');
const statusText = document.getElementById('status-text');

// Storage Keys
const SESSIONS_STORAGE_KEY = "cf_ai_chat_sessions_v1";
const CURRENT_ID_STORAGE_KEY = "cf_ai_chat_current_id_v1";
const DEFAULT_WELCOME = "Hello! I'm an LLM chat app powered by Cloudflare Workers AI. How can I help you today?";

// --- SYSTEM WORKSPACE STATE MACHINES ---
let chatSessions = JSON.parse(localStorage.getItem(SESSIONS_STORAGE_KEY)) || [];
let currentSessionId = localStorage.getItem(CURRENT_ID_STORAGE_KEY) || null;
let isProcessing = false;

// Sorter Run Traces
let executionHistory = [];
let currentStepIndex = -1;

// Configure Markdown Parser link formatting
if (window.marked) {
	marked.setOptions({ breaks: true, gfm: true });
	const renderer = new marked.Renderer();
	renderer.link = function({ href, title, text }) {
		const titleAttr = title ? ` title="${title}"` : '';
		return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
	};
	marked.use({ renderer });
}

// --- MODULE 1: INTER-TAB VIEW MANAGEMENT ---
tabChat.addEventListener("click", () => switchTab("chat"));
tabSorter.addEventListener("click", () => switchTab("sorter"));

function switchTab(target) {
	if (target === "chat") {
		tabChat.classList.add("active");
		tabSorter.classList.remove("active");
		panelChat.classList.add("active");
		panelSorter.classList.remove("active");
	} else {
		tabSorter.classList.add("active");
		tabChat.classList.remove("active");
		panelSorter.classList.add("active");
		panelChat.classList.remove("active");
		// Auto layout array matrix if it hasn't run yet
		if(executionHistory.length === 0) initializeArrayVisualizer();
	}
}

// --- MODULE 2: LLM CHAT CONTROLLER LOGIC ---
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
		if (msg.role !== "system") addMessageToChatUi(msg.role, msg.content);
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
		typingIndicator.classList.remove("visible");

		const assistantMessageEl = document.createElement("div");
		assistantMessageEl.className = "message assistant-message";
		assistantMessageEl.innerHTML = '<div class="msg-content"></div>';
		chatMessages.appendChild(assistantMessageEl);
		assistantTextEl = assistantMessageEl.querySelector(".msg-content");

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
						if (window.marked) {
							assistantTextEl.innerHTML = marked.parse(responseText);
						} else {
							assistantTextEl.textContent = responseText;
						}
						scrollToBottom();
					}
				} catch (e) { console.error("SSE parse error", e); }
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
		console.error(error);
		typingIndicator.classList.remove("visible");
		addMessageToChatUi("assistant", "Sorry, there was an error processing your request.");
	} {
		isProcessing = false;
		userInput.disabled = false;
		sendButton.disabled = false;
		userInput.focus();
	}
}

function addMessageToChatUi(role, content) {
	const messageEl = document.createElement("div");
	messageEl.className = `message ${role}-message`;
	messageEl.innerHTML = '<div class="msg-content"></div>';
	const target = messageEl.querySelector(".msg-content");
	
	if (window.marked && role === "assistant") {
		target.innerHTML = marked.parse(content);
	} else {
		target.textContent = content;
	}
	chatMessages.insertBefore(messageEl, typingIndicator);
	scrollToBottom();
}

function scrollToBottom() { chatMessages.scrollTop = chatMessages.scrollHeight; }

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

// --- MODULE 3: VISUAL MERGE SORT ENGINE ---
function initializeArrayVisualizer() {
	const rawValues = arrayInput.value.split(',');
	const filteredNumbers = rawValues
		.map(val => parseInt(val.trim()))
		.filter(val => !isNaN(val))
		.slice(0, 14); // Keep visual array clean on one layout line

	if(filteredNumbers.length === 0) {
		alert("Please enter a valid list of numbers!");
		return;
	}

	generateMergeSortTimeline(filteredNumbers);
	currentStepIndex = 0;
	renderSorterStep(currentStepIndex);
	updateSorterButtons();
}

function generateMergeSortTimeline(originArray) {
	executionHistory = [];
	
	function saveSnapshot(arr, msg, highlights = {}, completeSorted = false) {
		executionHistory.push({
			arrayState: [...arr],
			message: msg,
			highlights: highlights,
			completeSorted: completeSorted
		});
	}

	let traceArr = [...originArray];
	saveSnapshot(traceArr, "Initial state loaded. Ready to begin.");

	function mergeSortHelper(arr, startIdx) {
		if (arr.length <= 1) return arr;
		const mid = Math.floor(arr.length / 2);
		
		let splitHighlights = {};
		for(let i = 0; i < arr.length; i++) { splitHighlights[startIdx + i] = 'split'; }
		saveSnapshot(traceArr, `Splitting sub-array fragment at boundary indices [${startIdx} to ${startIdx + arr.length - 1}]`, splitHighlights);

		const leftSub = mergeSortHelper(arr.slice(0, mid), startIdx);
		const rightSub = mergeSortHelper(arr.slice(mid), startIdx + mid);

		return merge(leftSub, rightSub, startIdx);
	}

	function merge(left, right, startIdx) {
		let result = [];
		let i = 0, j = 0;

		while (i < left.length && j < right.length) {
			let compHighlights = {};
			compHighlights[startIdx + i] = 'compare';
			compHighlights[startIdx + left.length + j] = 'compare';
			saveSnapshot(traceArr, `Comparing subset pointer tracking values: ${left[i]} and ${right[j]}`, compHighlights);

			if (left[i] <= right[j]) {
				result.push(left[i]); i++;
			} else {
				result.push(right[j]); j++;
			}
		}

		while (i < left.length) { result.push(left[i]); i++; }
		while (j < right.length) { result.push(right[j]); j++; }

		for (let k = 0; k < result.length; k++) { traceArr[startIdx + k] = result[k]; }

		let mergeHighlights = {};
		for(let k = 0; k < result.length; k++) { mergeHighlights[startIdx + k] = 'sorted'; }
		saveSnapshot(traceArr, `Merged ordered segment run variant back: [${result.join(', ')}]`, mergeHighlights);

		return result;
	}

	mergeSortHelper(originArray, 0);
	saveSnapshot(traceArr, "Merge Sort Finished! Vector elements are sorted completely.", {}, true);
}

function renderSorterStep(index) {
	if (index < 0 || index >= executionHistory.length) return;
	const step = executionHistory[index];
	barStage.innerHTML = '';
	const maxVal = Math.max(...step.arrayState, 1);

	step.arrayState.forEach((value, idx) => {
		const bar = document.createElement('div');
		bar.className = 'bar';
		bar.innerText = value;
		
		const pct = Math.max((value / maxVal) * 100, 15);
		bar.style.height = `${pct}%`;

		if (step.completeSorted) {
			bar.style.backgroundColor = 'var(--col-sorted)';
		} else if (step.highlights[idx]) {
			const type = step.highlights[idx];
			if (type === 'split') bar.style.backgroundColor = 'var(--col-split)';
			if (type === 'compare') bar.style.backgroundColor = 'var(--col-compare)';
			if (type === 'sorted') bar.style.backgroundColor = 'var(--col-sorted)';
		}
		barStage.appendChild(bar);
	});
	statusText.innerText = `Step ${index + 1} of ${executionHistory.length}: ${step.message}`;
}

function updateSorterButtons() {
	prevBtn.disabled = currentStepIndex <= 0;
	nextBtn.disabled = currentStepIndex >= executionHistory.length - 1 || executionHistory.length === 0;
}

loadBtn.addEventListener('click', initializeArrayVisualizer);
nextBtn.addEventListener('click', () => {
	if (currentStepIndex < executionHistory.length - 1) {
		currentStepIndex++; renderSorterStep(currentStepIndex); updateSorterButtons();
	}
});
prevBtn.addEventListener('click', () => {
	if (currentStepIndex > 0) {
		currentStepIndex--; renderSorterStep(currentStepIndex); updateSorterButtons();
	}
});
resetSorterBtn.addEventListener('click', () => {
	barStage.innerHTML = '';
	statusText.innerText = "Load an array dataset above to observe structural steps.";
	currentStepIndex = -1;
	executionHistory = [];
	updateSorterButtons();
});

// --- MODULE 4: UNIFIED RUNTIME INITIALIZATION ---
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
