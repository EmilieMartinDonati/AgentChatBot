"use client"; // 

import { useState } from "react";

type Message = {
    text: string,
    role: "you" | "chat"
}

const orgIdTest = "acme-outdoor"

export default function ChatBox() {

    const [messages, setMessages] = useState<Message[]>([])
    const [input, setInput] = useState<string>("")

    const onSend = async (e: React.FormEvent) => {
        e.preventDefault()
        const inputText = input.trim()
        if (!inputText) return
        // append
        setMessages((prev) => [...prev, {
            role: "you",
            text: inputText
        }])
        // clear
        setInput("")

        const lastMessages = messages.slice(-6)

        // fetch answer
        const res = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: inputText, orgId: orgIdTest, history: lastMessages }),
        });
        const data = await res.json();
        setMessages((prev) => [...prev, { role: "chat", text: data.answer ?? data.error }]);
    }

    console.log("messages", messages)

    return (
        <div className="chat flex flex-col">
            {messages.map((m, i) => (
                <div key={i} className="flex flex-row gap-2 justify-center">
                    <p>{m.role}</p>
                    <p>{m.text}</p>
                </div>
            ))}
            <form id="chatbot" className="flex flex-col gap-2" onSubmit={onSend}>
                <input value={input} onChange={(e) => setInput(e.target.value)} />
                <button>Envoyer</button>
            </form>
        </div>
    )
}

