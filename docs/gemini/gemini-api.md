# Gemini 3 Pro is Now Available in Puter.js (Structured)

## Metadata

* Title: Gemini 3 Pro is Now Available in Puter.js
* Author: Reynaldi Chernando
* Date: November 19, 2025

## Introduction

Puter.js now supports Gemini 3 Pro, giving developers access to Google's latest frontier model.

## What is Gemini 3 Pro?

Gemini 3 Pro is the first model in Google's new Gemini 3 series, designed for complex tasks requiring broad world knowledge and advanced reasoning across multiple modalities (text, images, video, etc.). It comes with the following key capabilities:

### Key capabilities

* Advanced reasoning: Built on state-of-the-art reasoning foundations
* Agentic workflows: Designed to handle autonomous tasks and complex workflows
* Multimodal processing: Can work with text, images, PDFs, and video
* Dynamic thinking: Uses adaptive reasoning depth based on task complexity

## Examples

### Text generation

```javascript
puter.ai.chat("Explain neural networks simply", { model: 'gemini-3-pro-preview' });
```

### Complex reasoning

```javascript
puter.ai.chat("Compare the benefits and drawbacks of solar vs wind energy",
  { model: 'gemini-3-pro-preview' }
);
```

### Code generation

```javascript
puter.ai.chat("Write a Python function to sort a list",
  { model: 'gemini-3-pro-preview' }
);
```

## Get Started Now

Get Started Now

Just add one script tag to your HTML:

```html
<script src="https://js.puter.com/v2/"></script>
```

No API keys and no infrastructure setup. Start building with Gemini 3 Pro immediately.


---


# Free, Unlimited Gemini API（Structured）

## Metadata

* Title: **Free, Unlimited Gemini API**
* Author: **Nariman Jelveh**
* Updated: **November 19, 2025**

---

## Overview

This tutorial will show you how to use Puter.js to access Gemini's powerful language models for free, without any API keys or usage restrictions. Using Puter.js, you can leverage models like Gemini 2.5 Flash, Gemini 2.0 Flash, Gemini 3 Pro, and Gemini 2.5 Pro for various tasks like text generation, image analysis, and complex reasoning, text and code generation, and more.

Puter is the pioneer of the "User-Pays" model, which allows developers to incorporate AI capabilities into their applications while users cover their own usage costs. This model enables developers to access advanced AI capabilities for free, without any API keys or sign-ups.

---

## Getting Started

**Section title:**

Getting Started

**Description：**

Puter.js works without any API keys or sign-ups. To start using Puter.js, include the following script tag in your HTML file, either in the `<head>` or `<body>` section:

```html
<script src="https://js.puter.com/v2/"></script>
```

You're now ready to use Puter.js for free access to Gemini capabilities. No API keys or sign-ups are required.

---

## Example 1: Basic Text Generation with Gemini 2.5 Flash

**Intro sentence：**

Example 1: Basic Text Generation with Gemini 2.5 Flash
Here's a simple example showing how to generate text using Gemini 2.5 Flash:

```html
<html>
<body>
    <script src="https://js.puter.com/v2/"></script>
    <script>
        puter.ai.chat("Explain the concept of black holes in simple terms", {
            model: 'gemini-2.5-flash'
        }).then(response => {
            puter.print(response);
        });
    </script>
</body>
</html>
```

---

## Example 2: Using Gemini 3 Pro

**Intro sentence：**

Example 2: Using Gemini 3 Pro
For comparison, here's how to use Gemini 3 Pro:

```html
<html>
<body>
    <script src="https://js.puter.com/v2/"></script>
    <script>
        puter.ai.chat("What are the major differences between renewable and non-renewable energy sources?", {
            model: 'gemini-3-pro-preview'
        }).then(response => {
            puter.print(response);
        });
    </script>
</body>
</html>
```

---

## Example 3: Streaming Responses

**Intro sentence：**

Example 3: Streaming Responses
For longer responses, use streaming to get results in real-time:

```html
<html>
<body>
    <div id="output"></div>
    <script src="https://js.puter.com/v2/"></script>
    <script>
        async function streamResponses() {
            const outputDiv = document.getElementById('output');
            
            // Gemini 2.5 Flash with streaming
            outputDiv.innerHTML += '<h2>Gemini 2.5 Flash Response:</h2>';
            const flashResponse = await puter.ai.chat(
                "Explain the process of photosynthesis in detail", 
                {
                    model: 'gemini-2.5-flash',
                    stream: true
                }
            );
            
            for await (const part of flashResponse) {
                if (part?.text) {
                    outputDiv.innerHTML += part.text.replaceAll('\n', '<br>');
                }
            }            
        }

        streamResponses();
    </script>
</body>
</html>
```

---

## Example 4: Comparing Models

**Intro sentence：**

Example 4: Comparing Models
Here's how to compare responses from both Gemini models:

```html
<html>
<body>
    <script src="https://js.puter.com/v2/"></script>
    <script>
    (async () => {
        // Gemini 3 Pro
        const pro3_resp = await puter.ai.chat(
            'Tell me something interesting about quantum mechanics.',
            {model: 'gemini-3-pro-preview', stream: true}
        );
        puter.print('<h2>Gemini 3 Pro Response:</h2>');
        for await (const part of pro3_resp) {
            if (part?.text) {
                puter.print(part.text.replaceAll('\n', '<br>'));
            }
        }

        // Gemini 2.5 Pro
        const pro_resp = await puter.ai.chat(
            'Tell me something interesting about quantum mechanics.',
            {model: 'gemini-2.5-pro', stream: true}
        );
        puter.print('<h2>Gemini 2.5 Pro Response:</h2>');
        for await (const part of pro_resp) {
            if (part?.text) {
                puter.print(part.text.replaceAll('\n', '<br>'));
            }
        }

        // Gemini 2.5 Flash
        const flash_resp = await puter.ai.chat(
            'Tell me something interesting about quantum mechanics.',
            {model: 'gemini-2.5-flash', stream: true}
        );
        puter.print('<h2>Gemini 2.5 Flash Response:</h2>');
        for await (const part of flash_resp) {
            if (part?.text) {
                puter.print(part.text.replaceAll('\n', '<br>'));
            }
        }
    })();
    </script>
</body>
</html>
```

---

## Example 5: Image Analysis

**Intro sentence：**

Example 5: Image Analysis
To analyze images, simply provide an image URL to puter.ai.chat():

```html
<html>
<body>
    <script src="https://js.puter.com/v2/"></script>
    <img src="https://assets.puter.site/doge.jpeg" id="image">
    <script>
        puter.ai.chat(
            "What do you see in this image?",
            "https://assets.puter.site/doge.jpeg",
            { model: 'gemini-2.5-flash' }
        ).then(response => {
            puter.print(response);
        });
    </script>
</body>
</html>
```

---

## All models

**Section title：**

All models
The following Gemini models are available for free use with Puter.js:

* gemini-3-pro-preview
* gemini-2.5-pro
* gemini-2.5-flash-lite
* gemini-2.5-flash
* gemini-2.0-flash-lite
* gemini-2.0-flash
* gemini-1.5-flash

---

## Closing

That's it! You now have free access to Gemini's powerful language models using Puter.js. This allows you to add sophisticated AI capabilities to your web applications without worrying about API keys or usage limits.
