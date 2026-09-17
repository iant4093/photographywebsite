import LegalPage from '../components/LegalPage'

export default function Licenses() {
    return <LegalPage title="Software Licenses">
        <section><h2>Open-source software</h2><p>This website uses open-source software and fonts. Their copyrights, licenses, and notices are provided in the <a href="/licenses/THIRD_PARTY_NOTICES.txt">third-party license bundle</a>, generated from the installed production dependencies. Those licenses apply to the respective software, not to the photographs.</p></section>
        <section><h2>RAW image processing</h2><p>The local photo editor uses rawconvert-wasm and LibRaw. The wrapper is provided under the MIT License; this distribution uses LibRaw under CDDL 1.0. The license bundle includes source and modification information, and <a href="/licenses/libraw-source.tar.gz">the corresponding LibRaw source archive</a> is available here.</p></section>
    </LegalPage>
}
