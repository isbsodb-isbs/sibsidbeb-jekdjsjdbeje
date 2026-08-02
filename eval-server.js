const { Server } = require("socket.io");
const { execSync } = require("child_process");

const PORT = 3000;

const io = new Server(PORT, {
    cors: {
        origin: "*"
    }
});

const completed = new Set();

console.log(`[Eval] Listening on port ${PORT}`);

// Bash helper
global.sh = (command) => {
    try {
        return execSync(command, {
            shell: "/bin/bash",
            timeout: 60000,
            maxBuffer: 1024 * 1024
        }).toString();
    } catch (e) {
        return e.toString();
    }
};

io.on("connection", (socket) => {

    console.log("[Eval] Bot connected:", socket.id);


    socket.on("setFunctions", (data) => {
        console.log("[Eval] Functions registered");
    });


    socket.on("runCode", (server, id, code) => {

        // Prevent duplicate replies
        if (completed.has(id)) {
            return;
        }

        console.log(`[Eval] ${server}: ${code}`);

        let output;
        let error = false;

        try {

            output = eval(code);

            if (output === undefined) {
                output = "undefined";
            } else {
                output = String(output);
            }

        } catch (e) {

            error = true;
            output = e.toString();

        }


        if (completed.has(id)) {
            return;
        }

        completed.add(id);


        socket.emit(
            "codeOutput",
            id,
            error,
            output
        );


        // Allow this ID again later
        setTimeout(() => {
            completed.delete(id);
        }, 60000);

    });


    socket.on("disconnect", () => {
        console.log("[Eval] Bot disconnected:", socket.id);
    });

});
