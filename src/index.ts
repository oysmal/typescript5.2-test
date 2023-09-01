import "core-js/proposals/async-explicit-resource-management.js";
import "core-js/proposals/explicit-resource-management.js";
import fs from "fs/promises";
import { TransformStream, ReadableStream, ReadableStreamDefaultReader } from "node:stream/web";

declare const AsyncDisposableStack: any;

////////////////// FILE EXAMPLE /////////////////////
//
async function readFromFileExample1(path: string) {
    const file = await fs.open(path, "r");

    const cleanup = new AsyncDisposableStack();
    cleanup.defer(async () => {
        await file.close();
    })

    const data = await file.readFile();

    // ...
    // process data
    // ...

    return data; // file is closed automatically when it goes out of scope, whether successful or an error is thrown
}


// Monkey-patching fs.file until it supports Disposable
const originalOpen = fs.open;
fs.open = async function openDisposableFile(
    path: Parameters<typeof fs.open>[0],
    flags?: Parameters<typeof fs.open>[1],
    mode?: Parameters<typeof fs.open>[2]): Promise<AsyncDisposable & fs.FileHandle> {
    const file = await originalOpen(path, flags, mode);
    file[Symbol.asyncDispose] = async () => {
        console.log("Closing the file handle")
        await file.close();
    };
    return file;
}

async function readFromFileExample2(path: string) {
    await using file = await fs.open(path, "r");

    const data = await file.readFile();

    // ...
    // process data
    // ...

    return data; // file is closed automatically when it goes out of scope, whether successful or an error is thrown
}

////////////////// LOCK EXAMPLE /////////////////////

class Store<T> {
    private locked: Symbol | null = null;
    private _value: T;

    constructor(value: T) {
        this._value = value;
    }

    public setValue(value: T, lock: Symbol | null = null) {
        if (this.locked !== lock) {
            console.log("Locked, will not set value");
            return;
        }
        this._value = value;
    }

    get value() {
        return this._value;
    }

    public lock(lock: Symbol | null = null): Disposable & { symbol: Symbol } {
        if (this.locked !== lock) throw new Error("Already locked");
        const lockSymbol = Symbol("lock");
        this.locked = lockSymbol;
        return {
            symbol: lockSymbol,
            [Symbol.dispose]: () => {
                this.locked = null;
            }
        }
    }
}

const store = new Store(10);

async function testLockState() {
    using lock = store.lock();
    console.log("state.value", store.value);

    store.setValue(0, lock.symbol);
    console.log("state.value", store.value);

    await new Promise((res) => setTimeout(res, 1000));

    store.setValue(20, lock.symbol);
    console.log("state.value", store.value);
}

function testLockState2() {
    let i = 0;
    let interval = setInterval(() => {
        store.setValue(100);
        console.log("state.value", store.value);
        if (i === 10) clearInterval(interval);
        i++;
    }, 100)
}

////////////////// STREAM EXAMPLE /////////////////////

class SafeStreamReader implements Disposable {
    private stream: ReadableStream<any>;
    private reader: ReadableStreamDefaultReader<any> | undefined;

    constructor(stream: ReadableStream<any>) {
        this.stream = stream;
    }

    public getReader() {
        this.reader = this.stream.getReader();
        return this.reader;
    }

    [Symbol.dispose]() {
        console.log("disposing reader");
        this.reader?.releaseLock();
    }
}

const delayTransformStream = new TransformStream({
    async transform(chunk: ArrayBuffer, controller) {
        for (let i = 0; i < chunk.byteLength; i++) {
            await new Promise((res) => setTimeout(res, 1));
            controller.enqueue(chunk.slice(i, i + 1));
        }
    }
});

async function readStream(stream: ReadableStream<any>) {
    using safeStream = new SafeStreamReader(stream);
    const reader = safeStream.getReader();

    let body = [] as string[];
    let line = ""
    while (true) {
        const { done, value } = await reader.read();
        if (value) {
            const chunk = new TextDecoder("utf-8").decode(value);
            line += chunk;
            if (line.includes(".")) {
                const [line1, line2] = line.split(".");
                body.push(line1);
                console.log(line1);
                line = line2
            }
        }
        if (done) break;
    }

    return body;
}

async function runStreams() {
    await using content = await fs.open("./testFile.txt", "r");
    const stream = content.readableWebStream().pipeThrough(delayTransformStream);
    await readStream(stream);
}

///////////// RUN TESTS ///////////////////
async function main() {
    console.log("############### FILE EXAMPLE ###################")
    console.log(new TextDecoder().decode(await readFromFileExample1("./testFile.txt")));
    console.log(new TextDecoder().decode(await readFromFileExample2("./testFile.txt")));

    await new Promise((res) => setTimeout(res, 2000));
    console.log("############### LOCK EXAMPLE ###################")
    testLockState();
    testLockState2();

    await new Promise((res) => setTimeout(res, 2000));
    console.log("############### STREAMS EXAMPLE ###################")
    await runStreams();
}
main();
