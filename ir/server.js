// Node web server that serves files and ROP-over-WebSockets,
// launches rop_demo, and will also serve other JS modules.
//
// Usage:  node server.js [PATH] [PORT]

import url from "url";
import fs from "fs";
import path from "path";
import http from "http";
import { WebSocketServer } from "ws";
import { exec } from 'child_process';
import { Agent } from "./rop.js";
import { use, cell, wrap, state, onDrop } from "./i.js";

// For rop_demo.js
//
const recentKeys = wrap(_ => {
    const duration = 5000;

    let text = state([{t: Date.now(), data:"Type something..."}]);
    const updateText = (data) => {
        let now = Date.now();
        let old = now - duration;
        let a = text.peek().filter(e => e.t > old);
        a.push({t: now, data});
        text.set(a);
    };
    setTimeout(() => updateText(""), duration);

    const kbdata = (data) => {
        if (data == "\x03") {
            stdin.setRawMode(false);
            process.exit();
        }
        updateText(data);
        setTimeout(() => updateText(""), duration);
    };

    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.on("data", kbdata);
    onDrop(() => stdin.off("data", kbdata));

    return cell(() => {
        const str = use(text).map(e => e.data).join("");
        process.stdout.write("\r" + str + "   \x08\x08\x08");
        return str;
    });
});

//----------------------------------------------------------------
// HTTP & WebSocket Server
//----------------------------------------------------------------

const servePath = process.argv[2];
const servePort = process.argv[3] || "8002";
const serveHost = '127.0.0.1';
const serveURL = `http://${serveHost}:${servePort}/`;

const initialFuncs = {
    recentKeys: recentKeys,
};

const wss = new WebSocketServer({noServer: true});
// The connection event is sent when WSS is standalone; we emit it ourselves
// in the `noServer` use case for uniformity.
wss.on('connection', (ws, req) => new Agent(ws, initialFuncs, {}));

const template = [
    "<!DOCTYPE html>",
    "<html lang=en>",
    "  <head>",
    "    <meta charset=utf-8>",
    "    <meta name=viewport content='width=786'>",
    "    <title>TITLE</title>",
    "    <style>",
    "      body { margin: 12px; font: 16px Arial, Helvetica; }",
    "    </style>",
    "  </head>",
    "  <body>",
    "  <script type=module src='SRC'>",
    "  </script>",
    "  </body>",
    "</html>",
    ""
].join("\n");

const wrapScript = (title, path) =>
      template.replace(/SRC|TITLE/g, m => m == "TITLE" ? title : path);

const extTypes = {
    ".js": "text/javascript",
    ".txt": "text/plain",
};

const respondHtml = (resp, code, body) => {
    resp.writeHead(code, {"Content-Type": "text/html"});
    resp.end(body);
};

const serveFile = (filePath, resp) => {
    const ext = path.extname(filePath);
    const contentType = extTypes[ext] || "text/html";

    fs.readFile(filePath, (error, content) => {
        if (error) {
            return respondHtml(resp, 500, `Error: ${error.code}`);
        } else {
            resp.writeHead(200, { "Content-Type": contentType });
            resp.end(content, 'utf-8');
        }
    });
};

const server = http.createServer( (request, resp) => {
    const path = request.url;

    if (path.match(/\.\./)) {
        return respondHtml(resp, 500, "Traversal path");
    } else if (request.method != "GET") {
        return respondHtml(resp, 405, "Method not allowed");
    }

    if (path.match(/^\/[^/.?]*$/)) {
        // No extension => wrap javascript module in HTML
        const js = path == "/" ? "./rop_demo.js" : `.${path}.js`;
        const title = js.match(/\.\/(.*)\.js/)[1];
        return respondHtml(resp, 200, wrapScript(title, js));
    }

    // serve file

    let filePath = "." + path;
    // remap as per package.json "browser" section
    if (filePath == "./test.js") {
        filePath = "./no-test.js";
    }
    console.log(`File: ${filePath}`);
    serveFile(filePath, resp);
    return;
});

server.on('upgrade', (request, socket, head) => {
    const { pathname } = url.parse(request.url);
    if (pathname == "/rop" && request.headers.upgrade == "websocket") {
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
        });
    } else {
        socket.destroy();
    }
});

server.listen(servePort, serveHost);
console.log(`Listening on ${serveURL} ...`);

if (servePath) {
    // Launch browser...
    const openURL = serveURL + servePath.replace(/^\//,"");
    exec(`open '${openURL}'`, (error, stdout, stderr) => {
        if (error) console.error(`error: ${error.message}`);
        if (stderr) console.error(`stderr: ${stderr}`);
    });
}
