from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    
    # Listen to console logs
    page.on("console", lambda msg: print(f"Browser Console {msg.type}: {msg.text}"))
    page.on("pageerror", lambda err: print(f"Browser Error: {err}"))
    
    print("Navigating to VideoGallery...")
    page.goto("http://localhost:5173/video/a33417d5-7b2e-4a7b-a5df-bf24d23c13bc", wait_until="networkidle")
    
    print("Taking screenshot...")
    page.screenshot(path="debug/screenshot.png")
    browser.close()
