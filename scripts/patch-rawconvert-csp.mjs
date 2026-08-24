import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const corePath = resolve('node_modules/rawconvert-wasm/dist/rawconvert-core.js')
const packagePath = resolve('node_modules/rawconvert-wasm/package.json')
const expectedVersion = '0.1.1'
const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'))

if (packageJson.version !== expectedVersion) {
    throw new Error(`Review the RAW decoder CSP patch before using rawconvert-wasm ${packageJson.version}.`)
}

const source = readFileSync(corePath, 'utf8')
const startMarker = 'function createJsInvoker('
const endMarker = 'function craftInvokerFunction('
const start = source.indexOf(startMarker)
const end = source.indexOf(endMarker, start)

if (start === -1 || end === -1) {
    if (!source.includes('new Function(args1,invokerFnBody)')) process.exit(0)
    throw new Error('The rawconvert-wasm binding layout changed; refusing to apply an unsafe patch.')
}

const cspSafeInvoker = `function createJsInvoker(argTypes,isClassMethodFunc,returns,isAsync){
var needsDestructorStack=usesDestructorStack(argTypes);
var argCount=argTypes.length-2;
return function(humanName,throwBindingError,invoker,fn,runDestructors,fromRetWire,toClassParamWire,...wireFunctions){
var toArgWires=wireFunctions.slice(0,argCount);
var destructorFunctions=wireFunctions.slice(argCount);
return function(...args){
var destructors=needsDestructorStack?[]:null;
var wiredArgs=[fn];
var thisWired;
if(isClassMethodFunc){thisWired=toClassParamWire(destructors,this);wiredArgs.push(thisWired)}
var argWired=new Array(argCount);
for(var i=0;i<argCount;++i){argWired[i]=toArgWires[i](destructors,args[i]);wiredArgs.push(argWired[i])}
var rv=invoker(...wiredArgs);
if(needsDestructorStack){runDestructors(destructors)}else{
var destructorIndex=0;
for(var i=isClassMethodFunc?1:2;i<argTypes.length;++i){
if(argTypes[i].destructorFunction!==null){
var wiredValue=i===1?thisWired:argWired[i-2];
destructorFunctions[destructorIndex++](wiredValue)
}
}
}
if(returns){return fromRetWire(rv)}
if(isAsync){return rv}
}
}
}`

const patched = `${source.slice(0, start)}${cspSafeInvoker}${source.slice(end)}`

if (patched.includes('new Function(args1,invokerFnBody)')) {
    throw new Error('The rawconvert-wasm CSP patch did not remove dynamic JavaScript evaluation.')
}

writeFileSync(corePath, patched)
