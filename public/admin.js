// Upload Media
document.getElementById('uploadForm').addEventListener('submit', async e => {
    e.preventDefault();
    const file = document.getElementById('mediaFile').files[0];
    const name = document.getElementById('mediaName').value.trim();
    const type = document.getElementById('mediaType').value;
    if(!file||!name||!type){ alert('Fill all fields'); return; }

    const formData = new FormData();
    formData.append('mediaFile', file);
    formData.append('name', name);
    formData.append('type', type);

    const res = await fetch('/api/upload-media',{ method:'POST', body: formData });
    const data = await res.json();
    if(data.success){ alert('Uploaded!'); document.getElementById('uploadForm').reset(); loadMediaLibrary();}
    else alert('Upload failed');
});

// Load Media Library
async function loadMediaLibrary(){
    const res = await fetch('/api/media-library');
    const media = await res.json();
    const select = document.getElementById('media_id');
    select.innerHTML = '<option value="">None</option>';
    media.forEach(m=>{
        const opt=document.createElement('option');
        opt.value=m.id;
        opt.textContent=`${m.name} (${m.type})`;
        opt.dataset.base64=m.base64;
        opt.dataset.type=m.type;
        select.appendChild(opt);
    });
    select.addEventListener('change', ()=>{
        const sel = select.options[select.selectedIndex];
        const preview=document.getElementById('mediaSelectedPreview');
        if(sel.value){ preview.src=`data:${sel.dataset.type};base64,${sel.dataset.base64}`; preview.style.display='block'; }
        else{ preview.src=''; preview.style.display='none'; }
    });
}

// Schedule Message
document.getElementById('scheduleForm').addEventListener('submit', async e=>{
    e.preventDefault();
    const phones=document.getElementById('phone_number').value.trim().split(/[\n,]+/).map(p=>p.trim()).filter(p=>p);
    const text=document.getElementById('message_text').value.trim();
    const media_id=document.getElementById('media_id').value;
    const time=document.getElementById('scheduled_time').value;
    if(!phones.length||!time){ alert('Missing fields'); return; }
    for(const phone of phones){
        await fetch('/api/schedule-message',{ method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({phone_number:phone,message_text:text,media_id,scheduled_time:time})});
    }
    alert(`Scheduled for ${phones.length} numbers`);
    document.getElementById('scheduleForm').reset(); document.getElementById('mediaSelectedPreview').style.display='none';
    loadScheduledMessages();
});

// Load Scheduled Messages
async function loadScheduledMessages(){
    const res = await fetch('/api/scheduled-messages');
    const messages = await res.json();
    const tbody=document.getElementById('messagesTable'); tbody.innerHTML='';
    messages.forEach(msg=>{
        const tr=document.createElement('tr');
        tr.innerHTML=`<td>${msg.id}</td>
        <td>${msg.phone_number}</td>
        <td>${msg.message_text||'-'}</td>
        <td>${msg.media_name||'-'}</td>
        <td>${msg.media_base64?`<img src="data:${msg.media_type};base64,${msg.media_base64}" style="max-width:80px;max-height:60px;"/>`:'-'}</td>
        <td>${new Date(msg.scheduled_time).toLocaleString()}</td>
        <td>${msg.status}</td>`;
        tbody.appendChild(tr);
    });
}

loadMediaLibrary();
loadScheduledMessages();
