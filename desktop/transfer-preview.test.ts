import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { digest, extractDocxContent, extractDocxParagraphs, getImageMime, bufferToDataUrl } from './files.ts';
import { TransferHost } from './transfer-host.ts';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Server } from './test-support/transfer-server.ts';
import { DesktopService } from './service.ts';
import type { AgentHost } from './agent-host.ts';
import type { Case } from '../src/domain/workflow.ts';

async function setup(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pwb-transfer-prev-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const service = new DesktopService(root, { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' });
  service.key = 'profile-qa';
  service.account = { username: 'qa', displayName: '测试用户', organization: '合成组织', origin: 'https://test.baselandtec.com', userId: 'qa-user', status: 'authenticated', remembered: false };
  const work = path.join(root, 'work');
  await fs.mkdir(work);
  service.workspace.settings = { provider: '', baseUrl: '', model: '', workRoot: work };
  const c: Case = { id: 'qa-case', number: 'CASE-ONLY', title: '隔离提交案件', source: 'baseland', type: '发明', deadline: '', archived: false, tags: [], rounds: [], current: { kind: 'reply', processId: 'proc-1', remoteStatus: 400 }, remote: { caseId: 'remote-case', syncedAt: '', processes: [{ id: 'proc-1', name: '第一次审查意见', status: 400, node: '文件准备', undertaker: '测试用户', deadline: '' }] } };
  service.workspace.cases = [c];
  c.directory = await service.files().ensureCase(c);
  const client = new Server();
  service.client = client;
  const agent = { getCase: async () => ({ artifacts: [], process: { drafts: [] } }) } as unknown as AgentHost;
  const host = new TransferHost(service, agent);
  return { root, service, client, agent, host, c };
}

// 1x1 transparent PNG sample bytes
const SAMPLE_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
  0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
  0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82
]);

test('getImageMime correctly detects MIME by extension and magic bytes', () => {
  assert.equal(getImageMime('test.png'), 'image/png');
  assert.equal(getImageMime('test.jpg'), 'image/jpeg');
  assert.equal(getImageMime('test.jpeg'), 'image/jpeg');
  assert.equal(getImageMime('test.webp'), 'image/webp');
  assert.equal(getImageMime('test.svg'), 'image/svg+xml');
  assert.equal(getImageMime('unknown', SAMPLE_PNG), 'image/png');
});

test('extractDocxContent extracts text and embedded drawings in document order', async () => {
  const zip = new JSZip();
  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
</Relationships>`;

  const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    <w:p>
      <w:r><w:t>说明书附图说明：</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>图 1 为本发明系统架构示意图：</w:t></w:r>
      <w:r>
        <w:drawing>
          <wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">
            <wp:docPr id="1" name="图 1 架构示意图"/>
            <a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
              <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
                <pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
                  <pic:blipFill>
                    <a:blip r:embed="rIdImg1"/>
                  </pic:blipFill>
                </pic:pic>
              </a:graphicData>
            </a:graphic>
          </wp:inline>
        </w:drawing>
      </w:r>
    </w:p>
  </w:body>
</w:document>`;

  zip.file('word/_rels/document.xml.rels', relsXml);
  zip.file('word/document.xml', docXml);
  zip.file('word/media/image1.png', SAMPLE_PNG);

  const docxBytes = await zip.generateAsync({ type: 'nodebuffer' });
  const result = await extractDocxContent(docxBytes);

  assert.equal(result.imagesCount, 1);
  assert.match(result.text, /说明书附图说明：/);
  assert.match(result.text, /图 1 为本发明系统架构示意图：/);
  assert.match(result.text, /!\[图 1 架构示意图\]\(data:image\/png;base64,/);

  const paraResult = await extractDocxParagraphs(docxBytes);
  assert.ok(paraResult);
  assert.match(paraResult, /!\[图 1 架构示意图\]/);
});

test('extractDocxContent handles pure drawings docx without losing figures', async () => {
  const zip = new JSZip();
  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdDrawing1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/figure1.png"/>
  <Relationship Id="rIdDrawing2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/figure2.png"/>
</Relationships>`;

  const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    <w:p>
      <w:r>
        <w:drawing>
          <wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">
            <wp:docPr id="1" name="图 1"/>
            <a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
              <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
                <pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
                  <pic:blipFill>
                    <a:blip r:embed="rIdDrawing1"/>
                  </pic:blipFill>
                </pic:pic>
              </a:graphicData>
            </a:graphic>
          </wp:inline>
        </w:drawing>
      </w:r>
    </w:p>
    <w:p>
      <w:r>
        <w:drawing>
          <wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">
            <wp:docPr id="2" name="图 2"/>
            <a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
              <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
                <pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
                  <pic:blipFill>
                    <a:blip r:embed="rIdDrawing2"/>
                  </pic:blipFill>
                </pic:pic>
              </a:graphicData>
            </a:graphic>
          </wp:inline>
        </w:drawing>
      </w:r>
    </w:p>
  </w:body>
</w:document>`;

  zip.file('word/_rels/document.xml.rels', relsXml);
  zip.file('word/document.xml', docXml);
  zip.file('word/media/figure1.png', SAMPLE_PNG);
  zip.file('word/media/figure2.png', SAMPLE_PNG);

  const docxBytes = await zip.generateAsync({ type: 'nodebuffer' });
  const result = await extractDocxContent(docxBytes);

  assert.equal(result.imagesCount, 2);
  assert.match(result.text, /!\[图 1\]\(data:image\/png;base64,/);
  assert.match(result.text, /!\[图 2\]\(data:image\/png;base64,/);

  // extractDocxParagraphs must NOT be empty or undefined
  const paraText = await extractDocxParagraphs(docxBytes);
  assert.ok(paraText);
  assert.ok(paraText.includes('![图 1]'));
  assert.ok(paraText.includes('![图 2]'));
});

test('extractDocxContent extracts FIVE_PARTS with drawings for 100003 说明书附图', async () => {
  const zip = new JSZip();
  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rH1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
  <Relationship Id="rH2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header2.xml"/>
  <Relationship Id="rImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/drawing1.png"/>
</Relationships>`;

  const header1Xml = `<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>权利要求书</w:t></w:r></w:p></w:hdr>`;
  const header2Xml = `<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>说明书附图</w:t></w:r></w:p></w:hdr>`;

  const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    <w:p>
      <w:r><w:t>1. 一种专利方法。</w:t></w:r>
      <w:pPr><w:sectPr><w:headerReference w:type="default" r:id="rH1"/></w:sectPr></w:pPr>
    </w:p>
    <w:p>
      <w:r>
        <w:drawing>
          <wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">
            <wp:docPr id="10" name="附图 1 流程图"/>
            <a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
              <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
                <pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
                  <pic:blipFill>
                    <a:blip r:embed="rImg1"/>
                  </pic:blipFill>
                </pic:pic>
              </a:graphicData>
            </a:graphic>
          </wp:inline>
        </w:drawing>
      </w:r>
      <w:pPr><w:sectPr><w:headerReference w:type="default" r:id="rH2"/></w:sectPr></w:pPr>
    </w:p>
  </w:body>
</w:document>`;

  zip.file('word/_rels/document.xml.rels', relsXml);
  zip.file('word/header1.xml', header1Xml);
  zip.file('word/header2.xml', header2Xml);
  zip.file('word/document.xml', docXml);
  zip.file('word/media/drawing1.png', SAMPLE_PNG);

  const docxBytes = await zip.generateAsync({ type: 'nodebuffer' });
  const result = await extractDocxContent(docxBytes);

  assert.ok(result.parts);
  const claimsPart = result.parts.find(p => p.code === '100001');
  const drawingsPart = result.parts.find(p => p.code === '100003');

  assert.ok(claimsPart);
  assert.match(claimsPart.content, /1\. 一种专利方法。/);

  assert.ok(drawingsPart);
  // Drawing part must contain the drawing image, NOT '（本部分无正文）'
  assert.notEqual(drawingsPart.content, '（本部分无正文）');
  assert.match(drawingsPart.content, /!\[附图 1 流程图\]\(data:image\/png;base64,/);
});

test('extractDocxContent handles oversized images gracefully', async () => {
  const zip = new JSZip();
  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdBig" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/big.png"/>
</Relationships>`;

  const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    <w:p>
      <w:r>
        <w:drawing>
          <wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">
            <wp:docPr id="1" name="超大图"/>
            <a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
              <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
                <pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
                  <pic:blipFill><a:blip r:embed="rIdBig"/></pic:blipFill>
                </pic:pic>
              </a:graphicData>
            </a:graphic>
          </wp:inline>
        </w:drawing>
      </w:r>
    </w:p>
  </w:body>
</w:document>`;

  // Create 100 bytes buffer but set maxImageBytes option to 50 bytes
  const mockImage = Buffer.alloc(100, 0x12);
  zip.file('word/_rels/document.xml.rels', relsXml);
  zip.file('word/document.xml', docXml);
  zip.file('word/media/big.png', mockImage);

  const docxBytes = await zip.generateAsync({ type: 'nodebuffer' });
  const result = await extractDocxContent(docxBytes, { maxImageBytes: 50 });

  assert.match(result.text, /附图过大，已略过预览/);
});

test('previewFile supports standalone image file preview', async t => {
  const { service, host, c } = await setup(t);
  let v = await host.prepare(service.key, c.id);

  const imgPath = await service.casePath(c.id, '附图1.png');
  await fs.writeFile(imgPath, SAMPLE_PNG);

  (host as any).sessions.get(v.id).files.reply = {
    name: '附图1.png',
    relativePath: '附图1.png',
    hash: digest(SAMPLE_PNG),
  };

  const preview = await host.previewFile(service.key, v.id, { role: 'reply' });
  assert.equal(preview.name, '附图1.png');
  assert.equal(preview.mediaType, 'image');
  assert.ok(preview.dataUrl?.startsWith('data:image/png;base64,'));
  assert.match(preview.content || '', /!\[附图1\.png\]\(data:image\/png;base64,/);
});

test('explicit preview identities never fall back or download files outside the session', async t => {
  const { service, host, c, client } = await setup(t);
  client.form={File:{FileNo:'owned-file',FileName:'本案.txt'}};
  const view=await host.prepare(service.key,c.id);
  let downloads=0;
  client.download=async()=>{downloads++;return Buffer.from('本案材料');};
  for(const ref of [{fileNo:'other-file'},{fileNo:'owned-file',name:'其他案.txt'},{name:'不存在.txt'},{role:'reply' as const},{partCode:'missing'}]){
    await assert.rejects(host.previewFile(service.key,view.id,ref),/不存在|不属于|无法唯一/);
  }
  assert.equal(downloads,0);
  const preview=await host.previewFile(service.key,view.id,{fileNo:'owned-file',name:'本案.txt'});
  assert.equal(preview.content,'本案材料');
  assert.equal(downloads,1);
});

test('preview rejects changed copies and account/process ABA during download or extraction', async t => {
  const { service, host, c, client, root } = await setup(t);
  client.form={File:{fileNo:'owned-file',name:'本案.txt'}};
  let view=await host.prepare(service.key,c.id);
  const source=path.join(root,'reply.docx');
  await fs.copyFile(path.resolve('resources/document-templates/reply.docx'),source);
  view=await host.addFile(service.key,view.id,'reply',source);
  await fs.writeFile(await service.casePath(c.id,view.files[0].relativePath),'changed');
  await assert.rejects(host.previewFile(service.key,view.id,{role:'reply'}),/副本已经变化/);
  client.download=async()=>{service.generation+=2;return Buffer.from('late');};
  await assert.rejects(host.previewFile(service.key,view.id,{fileNo:'owned-file'}),/作用域已变化/);
  service.generation-=2;
  client.download=async()=>Buffer.from('content');
  const original=(host as any).generateFilePreview.bind(host);
  (host as any).generateFilePreview=async(...args:unknown[])=>{
    const result=await original(...args);
    (service as any).bumpCaseRevision(c.id);
    (service as any).bumpCaseRevision(c.id);
    return result;
  };
  await assert.rejects(host.previewFile(service.key,view.id,{fileNo:'owned-file'}),/重新切换/);
});
