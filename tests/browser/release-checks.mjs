import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { resolve, extname, sep } from 'node:path'
import { chromium } from 'playwright'

// Built local artifacts only. Auth and every API call are synthetic; no AWS writes.
const root = resolve('dist')
const types = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.json':'application/json', '.wasm':'application/wasm', '.woff2':'font/woff2' }
const server = createServer(async (req, res) => {
    try {
        const path = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://local').pathname))
        if (!path.startsWith(root + sep) && path !== root) { res.writeHead(403).end(); return }
        let file = path
        try { if (!(await stat(file)).isFile()) file = resolve(root, 'index.html') }
        catch { if (extname(path)) { res.writeHead(404).end(); return }; file = resolve(root, 'index.html') }
        res.writeHead(200, { 'content-type':types[extname(file)] || 'application/octet-stream' })
        res.end(await readFile(file))
    } catch { res.writeHead(500).end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
const clientId = process.env.VITE_COGNITO_CLIENT_ID || 'test-client-id'
const browser = await chromium.launch({ headless:true, ...(process.env.BROWSER_CHANNEL ? { channel:process.env.BROWSER_CHANNEL } : {}) })
const users = [{sub:'11111111-1111-4111-8111-111111111111',email:'first@example.test'}, {sub:'22222222-2222-4222-8222-222222222222',email:'second@example.test'}]
const outcomes = []
async function contextFor(width, authenticated = false) {
    const context = await browser.newContext({viewport:{width,height:900},isMobile:width<500,hasTouch:width<500,serviceWorkers:'block'})
    if (authenticated) {
        const now = Math.floor(Date.now()/1000)
        const token = use => [Buffer.from('{"alg":"none"}').toString('base64url'),Buffer.from(JSON.stringify({sub:'synthetic',email:'synthetic@example.test','cognito:groups':['Admins'],token_use:use,iat:now,exp:now+3600})).toString('base64url'),'fixture'].join('.')
        await context.addInitScript(({clientId,id,access}) => {
            const prefix=`CognitoIdentityServiceProvider.${clientId}`, username='synthetic@example.test'
            localStorage.setItem(prefix+'.LastAuthUser',username)
            for (const [key,value] of Object.entries({idToken:id,accessToken:access,refreshToken:'fixture',clockDrift:'0'})) localStorage.setItem(`${prefix}.${username}.${key}`,value)
        }, {clientId,id:token('id'),access:token('access')})
    }
    await context.addInitScript(() => localStorage.setItem('ian-photography-analytics','disabled'))
    await context.route('**/*', async route => {
        const req=route.request(), url=new URL(req.url())
        if(url.hostname.startsWith('cognito-idp.')) return route.fulfill({status:200,contentType:'application/x-amz-json-1.1',headers:{'access-control-allow-origin':'*'},body:JSON.stringify({Username:'synthetic@example.test',UserAttributes:[{Name:'email',Value:'synthetic@example.test'}],UserMFASettingList:['SOFTWARE_TOKEN_MFA'],PreferredMfaSetting:'SOFTWARE_TOKEN_MFA'})})
        if(url.pathname.startsWith('/api/')) return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({users,items:[],images:[],nextCursor:null,totalPhotos:0})})
        if(url.origin!==origin || !['GET','HEAD'].includes(req.method())) return route.abort()
        return route.continue()
    })
    return context
}
try {
    for (const width of [1440,390]) {
        for (const mode of ['edit','delete']) {
            const context=await contextFor(width,true), page=await context.newPage(), errors=[]
            page.on('pageerror',error=>errors.push(error.message))
            let release, observed
            const held=new Promise(resolve=>{release=resolve}), accepted=new Promise(resolve=>{observed=resolve})
            let mutations=0
            await page.route('**/api/users/*', async route => {
                mutations++; observed(); await held
                await route.fulfill({contentType:'application/json',body:JSON.stringify({albumsDeleted:1,albumsUpdated:1})}).catch(()=>{})
            })
            await page.goto(origin+'/admin/users/'+mode)
            await page.getByText(users[0].email,{exact:true}).waitFor()
            const button=mode==='edit'?'Edit':'Delete'
            await page.getByRole('button',{name:button,exact:true}).first().click()
            const dialog=page.getByRole('dialog')
            await dialog.waitFor()
            assert.equal(await dialog.locator('input').evaluate(node=>node===document.activeElement),true)
            for(let i=0;i<8;i++) { await page.keyboard.press('Tab'); assert.equal(await dialog.evaluate(node=>node.contains(document.activeElement)),true) }
            if(mode==='edit') {
                await dialog.locator('input').fill('changed@example.test')
                await dialog.getByRole('button',{name:'Save Changes'}).click()
            } else {
                await dialog.locator('input').fill('confirm')
                await dialog.getByRole('button',{name:'Delete Permanently'}).click()
            }
            await accepted
            await dialog.getByRole('button',{name:'Cancel'}).click()
            await page.getByRole('button',{name:button,exact:true}).nth(1).click()
            release()
            await page.waitForTimeout(300)
            assert.equal(await dialog.isVisible(),true)
            assert.match(await dialog.innerText(),/second@example.test/)
            await page.keyboard.press('Escape')
            await dialog.waitFor({state:'hidden'})
            assert.equal(await page.getByRole('button',{name:button,exact:true}).nth(1).evaluate(node=>node===document.activeElement),true)
            assert.equal(mutations,1); assert.deepEqual(errors,[])
            outcomes.push({width,check:mode+' dialog race/focus/escape',passed:true})
            await context.close()
        }
        {
            const context=await contextFor(width,true), page=await context.newPage()
            let release
            const held=new Promise(resolve=>{release=resolve})
            await page.route('**/api/users?*', async route => {
                if(new URL(route.request().url()).searchParams.has('paginationToken')) {
                    await held
                    return route.fulfill({status:500,contentType:'application/json',body:'{"error":"Synthetic directory outage"}'})
                }
                return route.fulfill({contentType:'application/json',body:JSON.stringify({users:[users[0]],nextCursor:'next'})})
            })
            await page.goto(origin+'/admin/users/edit')
            await page.getByText(users[0].email,{exact:true}).waitFor()
            await page.getByText(/Search results are still updating/).waitFor()
            release()
            await page.getByRole('alert').waitFor()
            assert.equal(await page.getByText(users[0].email,{exact:true}).isVisible(),true)
            assert.equal(await page.getByText('No users found.',{exact:true}).count(),0)
            outcomes.push({width,check:'incremental directory and failure preservation',passed:true})
            await context.close()
        }
        {
            const context=await contextFor(width), page=await context.newPage()
            await page.route('**/assets/Contact-*.js',route=>route.abort())
            await page.goto(origin)
            if(await page.locator('a[href="/contact"]:visible').count()===0) await page.locator('.linen-menu-toggle').click()
            await page.locator('a[href="/contact"]:visible').first().click()
            await page.getByRole('alert').filter({hasText:'This page could not be opened'}).waitFor()
            assert.ok(await page.locator('nav').count())
            await page.getByRole('link',{name:'Go to home',exact:true}).click()
            await page.getByRole('link',{name:'Explore Photos',exact:true}).waitFor()
            outcomes.push({width,check:'failed lazy route retains recovery and navigation',passed:true})
            await context.close()
        }
        {
            const context=await contextFor(width), a=await context.newPage(), errors=[]
            a.on('pageerror',error=>errors.push(error.message))
            await a.goto(origin+'/editor')
            await a.getByRole('heading',{name:'Photo Editor',exact:true}).waitFor()
            const bytes=await a.evaluate(async()=>{
                const c=document.createElement('canvas');c.width=120;c.height=80
                c.getContext('2d').fillRect(0,0,120,80)
                return Array.from(new Uint8Array(await (await new Promise(resolve=>c.toBlob(resolve,'image/png'))).arrayBuffer()))
            })
            await a.locator('input[type=file]').setInputFiles({name:'a.png',mimeType:'image/png',buffer:Buffer.from(bytes)})
            await a.getByText('120 × 80 working preview',{exact:true}).first().waitFor()
            const b=await context.newPage()
            b.on('pageerror',error=>errors.push(error.message))
            await b.goto(origin+'/editor')
            await b.getByRole('heading',{name:'Photo Editor',exact:true}).waitFor()
            await b.locator('input[type=file]').setInputFiles({name:'b.png',mimeType:'image/png',buffer:Buffer.from(bytes)})
            await b.getByText('120 × 80 working preview',{exact:true}).first().waitFor()
            await b.getByText('Saved locally',{exact:true}).waitFor()
            await a.getByRole('spinbutton',{name:'Exposure value',exact:true}).fill('2')
            await a.evaluate(()=>window.dispatchEvent(new Event('pagehide')))
            await a.waitForTimeout(750)
            const saved=await b.evaluate(()=>new Promise((resolve,reject)=>{
                const open=indexedDB.open('ian-truong-photo-editor',1)
                open.onerror=()=>reject(open.error)
                open.onsuccess=()=>{
                    const db=open.result,tx=db.transaction('session'),store=tx.objectStore('session')
                    let source,state
                    store.get('source').onsuccess=e=>{source=e.target.result}
                    store.get('state').onsuccess=e=>{state=e.target.result}
                    tx.oncomplete=()=>{db.close();resolve({name:source.name,bound:source.sourceId===state?.sourceId,exposure:state?.state.adjustments.exposure})}
                }
            }))
            assert.deepEqual(saved,{name:'b.png',bound:true,exposure:0})
            assert.deepEqual(errors,[])
            outcomes.push({width,check:'real two-tab editor recovery binding',passed:true})
            await context.close()
        }
    }
    console.log(JSON.stringify(outcomes,null,2))
} finally { await browser.close(); await new Promise(resolve=>server.close(resolve)) }
