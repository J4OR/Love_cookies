import { db } from "./firebase-config.js";
import {
  collection, doc, addDoc, updateDoc, deleteDoc, onSnapshot, orderBy, query
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

(function(){
  const productosRef = collection(db, "productos");
  const recetasRef = collection(db, "recetas");

  let productos = []; // se llena en tiempo real desde Firestore
  let recetas = [];
  let filtroLugar = "";

  // ---------------- Unidades y cálculo de costos ----------------
  const UNIDADES = {
    g:{dim:"masa",f:1,txt:"g (gramos)"}, kg:{dim:"masa",f:1000,txt:"kg (kilos)"},
    ml:{dim:"vol",f:1,txt:"ml"}, l:{dim:"vol",f:1000,txt:"l (litros)"},
    und:{dim:"cant",f:1,txt:"und (unidades)"}
  };
  const opcionesUnidad = (sel)=> '<option value="">Unidad</option>' +
    Object.entries(UNIDADES).map(([k,u])=>`<option value="${k}"${k===sel?" selected":""}>${u.txt}</option>`).join("");
  const dinero = (n)=> "$" + Number(n||0).toLocaleString(undefined,{maximumFractionDigits:2});
  const numero = (n)=> Number(n).toLocaleString(undefined,{maximumFractionDigits:2});

  function buscarProducto(it){
    return productos.find(p=>p.id===it.productId) || productos.find(p=>p.name===it.productName);
  }
  // Lee cantidad y unidad de un ingrediente (también entiende textos viejos como "200g")
  function leerCantidad(it, prod){
    if(it.unit) return { num: parseFloat(String(it.quantity).replace(",",".")), unit: it.unit };
    const m = String(it.quantity).trim().toLowerCase().match(/^([\d.,]+)\s*([a-z]*)/);
    if(!m) return { num: NaN, unit: "" };
    const alias = {gr:"g",gramo:"g",gramos:"g",kilo:"kg",kilos:"kg",lt:"l",litro:"l",litros:"l",unidad:"und",unidades:"und",u:"und"};
    let u = m[2] || (prod && prod.unit) || "";
    u = alias[u] || u;
    return { num: parseFloat(m[1].replace(",",".")), unit: u };
  }
  // Costo de un ingrediente = precio del paquete x (cantidad usada / cantidad del paquete)
  function costoItem(it){
    const prod = buscarProducto(it);
    if(!prod) return { ok:false, motivo:"el producto ya no existe" };
    const pu = UNIDADES[prod.unit];
    if(!pu) return { ok:false, motivo:"al producto le falta la unidad (edítalo)" };
    const paquete = parseFloat(prod.quantity);
    if(!(paquete>0)) return { ok:false, motivo:"el producto no tiene una cantidad válida" };
    const q = leerCantidad(it, prod);
    const iu = UNIDADES[q.unit];
    if(!iu || !(q.num>=0)) return { ok:false, motivo:"cantidad o unidad inválida" };
    if(iu.dim!==pu.dim) return { ok:false, motivo:`no se puede convertir ${q.unit} a ${prod.unit}` };
    const base = q.num*iu.f;
    return { ok:true, base, dim:iu.dim, nombre:prod.name,
             costo:(Number(prod.price)||0)*base/(paquete*pu.f) };
  }
  function costoReceta(r){
    const items = r.items.map(it=>({ it, c: costoItem(it) }));
    const total = items.reduce((t,x)=> t + (x.c.ok ? x.c.costo : 0), 0);
    return { items, total, fallos: items.filter(x=>!x.c.ok).length };
  }
  function cantidadBonita(base, dim){
    if(dim==="masa") return base>=1000 ? numero(base/1000)+" kg" : numero(base)+" g";
    if(dim==="vol") return base>=1000 ? numero(base/1000)+" l" : numero(base)+" ml";
    return numero(base)+" und";
  }

  // ---------------- Ventana emergente (modal) genérica ----------------
  const modalOverlay = document.getElementById("modal-overlay");
  const modalBox = document.getElementById("modal-box");

  function abrirModal(html){
    modalBox.innerHTML = html;
    modalOverlay.classList.remove("hidden");
  }
  function cerrarModal(){
    modalOverlay.classList.add("hidden");
    modalBox.innerHTML = "";
  }
  modalOverlay.addEventListener("click", (e)=>{
    if(e.target === modalOverlay) cerrarModal();
  });

  function confirmarAccion(mensaje, textoBoton, onConfirmar){
    abrirModal(`
      <h3>Confirmar</h3>
      <p>${escapeHtml(mensaje)}</p>
      <div class="modal-actions">
        <button class="secondary" id="modal-cancelar">Cancelar</button>
        <button class="danger" id="modal-confirmar">${escapeHtml(textoBoton)}</button>
      </div>
    `);
    document.getElementById("modal-cancelar").addEventListener("click", cerrarModal);
    document.getElementById("modal-confirmar").addEventListener("click", async ()=>{
      cerrarModal();
      await onConfirmar();
    });
  }

  // ---- Tabs ----
  document.querySelectorAll(".tab").forEach(t=>{
    t.addEventListener("click", ()=>{
      document.querySelectorAll(".tab").forEach(x=>x.classList.remove("active"));
      document.querySelectorAll(".panel").forEach(x=>x.classList.remove("active"));
      t.classList.add("active");
      document.getElementById("panel-"+t.dataset.tab).classList.add("active");
    });
  });

  // ---- Productos ----
  const elNombre = document.getElementById("p-nombre");
  const elPrecio = document.getElementById("p-precio");
  const elCantidad = document.getElementById("p-cantidad");
  const elLugar = document.getElementById("p-lugar");
  const btnGuardar = document.getElementById("p-guardar");
  const elFiltroLugar = document.getElementById("p-filtro-lugar");

  elFiltroLugar.addEventListener("change", ()=>{
    filtroLugar = elFiltroLugar.value;
    renderProductos();
  });

  // Escucha en tiempo real: cada vez que cambie algo en "productos" en Firestore,
  // esta función se vuelve a ejecutar sola y refresca la pantalla.
  onSnapshot(query(productosRef, orderBy("name")), (snapshot)=>{
    productos = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    renderProductos();
    renderRecetas(); // el selector de productos dentro de recetas también depende de esto
  }, (error)=>{
    console.error("Error leyendo productos:", error);
    document.getElementById("lista-productos").innerHTML =
      '<div class="empty">No se pudo conectar con la base de datos. Revisa la consola.</div>';
  });

  function actualizarOpcionesFiltro(){
    const lugares = [...new Set(productos.map(p=>p.place).filter(l=>l && l.trim()))].sort((a,b)=>a.localeCompare(b));
    const valorActual = elFiltroLugar.value;
    elFiltroLugar.innerHTML = '<option value="">Todos los lugares</option>' +
      lugares.map(l=>`<option value="${escapeHtml(l)}">${escapeHtml(l)}</option>`).join("");
    if(lugares.includes(valorActual)) elFiltroLugar.value = valorActual;
    else filtroLugar = "";
  }

  function renderProductos(){
    actualizarOpcionesFiltro();
    const cont = document.getElementById("lista-productos");
    const productosFiltrados = filtroLugar
      ? productos.filter(p => p.place === filtroLugar)
      : productos;
    if(productosFiltrados.length===0){
      cont.innerHTML = '<div class="empty">'+
        (productos.length===0 ? 'Aún no hay productos agregados.' : 'No hay productos en ese lugar de compra.')
        +'</div>';
      return;
    }
    cont.innerHTML = '<div class="card overflow-x">' + productosFiltrados.map(p=>`
      <div class="item">
        <div class="item-info">
          <b>${escapeHtml(p.name)}</b> — ${dinero(p.price)} · ${escapeHtml(String(p.quantity||""))} ${escapeHtml(p.unit||"")}
          <div class="muted">${escapeHtml(p.place||"")}</div>
        </div>
        <div class="item-actions">
          <button class="small secondary" data-edit="${p.id}">Editar</button>
          <button class="small danger" data-del="${p.id}">Eliminar</button>
        </div>
      </div>`).join("") + '</div>';

    cont.querySelectorAll("[data-edit]").forEach(b=>{
      b.addEventListener("click", ()=> abrirModalEditarProducto(b.dataset.edit));
    });
    cont.querySelectorAll("[data-del]").forEach(b=>{
      b.addEventListener("click", ()=> {
        const p = productos.find(x=>x.id===b.dataset.del);
        confirmarAccion(`¿Eliminar "${p.name}"?`, "Eliminar", async ()=>{
          try{ await deleteDoc(doc(db, "productos", p.id)); }
          catch(e){ console.error(e); alert("No se pudo eliminar el producto."); }
        });
      });
    });
  }

  function abrirModalEditarProducto(id){
    const p = productos.find(x=>x.id===id);
    if(!p) return;
    abrirModal(`
      <h3>Editar producto</h3>
      <div class="form-row"><input id="m-nombre" placeholder="Nombre del producto"></div>
      <div class="form-row"><input id="m-precio" type="number" step="0.01" placeholder="Precio"></div>
      <div class="form-row"><input id="m-cantidad" type="number" step="any" inputmode="decimal" placeholder="Cantidad del paquete"><select id="m-unidad"></select></div>
      <div class="form-row"><input id="m-lugar" placeholder="Lugar de compra"></div>
      <div class="modal-actions">
        <button class="secondary" id="modal-cancelar">Cancelar</button>
        <button id="modal-guardar">Guardar cambios</button>
      </div>
    `);
    document.getElementById("m-nombre").value = p.name || "";
    document.getElementById("m-precio").value = p.price || 0;
    document.getElementById("m-cantidad").value = p.quantity || "";
    document.getElementById("m-unidad").innerHTML = opcionesUnidad(p.unit || "");
    document.getElementById("m-lugar").value = p.place || "";
    document.getElementById("modal-cancelar").addEventListener("click", cerrarModal);
    document.getElementById("modal-guardar").addEventListener("click", async ()=>{
      const name = document.getElementById("m-nombre").value.trim();
      if(!name){ alert("Escribe el nombre del producto."); return; }
      const data = {
        name,
        price: parseFloat(document.getElementById("m-precio").value)||0,
        quantity: parseFloat(document.getElementById("m-cantidad").value)||0,
        unit: document.getElementById("m-unidad").value,
        place: document.getElementById("m-lugar").value.trim()
      };
      try{
        await updateDoc(doc(db, "productos", id), data);
        cerrarModal();
      }catch(e){
        console.error(e);
        alert("No se pudo guardar el producto.");
      }
    });
  }

  btnGuardar.addEventListener("click", async ()=>{
    const name = elNombre.value.trim();
    if(!name){ alert("Escribe el nombre del producto."); return; }
    const data = {
      name,
      price: parseFloat(elPrecio.value)||0,
      quantity: parseFloat(elCantidad.value)||0,
      unit: document.getElementById("p-unidad").value,
      place: elLugar.value.trim()
    };
    btnGuardar.disabled = true;
    try{
      await addDoc(productosRef, data);
      elNombre.value=elPrecio.value=elCantidad.value=elLugar.value="";
    }catch(e){
      console.error(e);
      alert("No se pudo guardar el producto.");
    }finally{
      btnGuardar.disabled = false;
    }
  });

  // ---- Recetas ----
  const elRecNombre = document.getElementById("r-nombre");
  const elRecRinde = document.getElementById("r-rinde");
  const elCReceta = document.getElementById("c-receta");
  const elCGalletas = document.getElementById("c-galletas");
  document.getElementById("p-unidad").innerHTML = opcionesUnidad("g");

  document.getElementById("r-nueva").addEventListener("click", async ()=>{
    const name = elRecNombre.value.trim();
    if(!name){ alert("Escribe el nombre de la receta."); return; }
    try{
      await addDoc(recetasRef, { name, rinde: parseInt(elRecRinde.value)||0, items: [] });
      elRecNombre.value = elRecRinde.value = "";
    }catch(e){
      console.error(e);
      alert("No se pudo crear la receta.");
    }
  });

  onSnapshot(query(recetasRef, orderBy("name")), (snapshot)=>{
    recetas = snapshot.docs.map(d => ({ id: d.id, ...d.data(), items: d.data().items || [] }));
    renderRecetas();
  }, (error)=>{
    console.error("Error leyendo recetas:", error);
    document.getElementById("lista-recetas").innerHTML =
      '<div class="empty">No se pudo conectar con la base de datos. Revisa la consola.</div>';
  });

  function renderRecetas(){
    const cont = document.getElementById("lista-recetas");
    renderCalcular();
    if(recetas.length===0){
      cont.innerHTML = '<div class="empty">Aún no hay recetas creadas.</div>';
      return;
    }
    cont.innerHTML = recetas.map(r=>{
      const cr = costoReceta(r);
      return `
      <div class="card" data-recid="${r.id}">
        <div class="item">
          <div class="item-info"><b>${escapeHtml(r.name)}</b>
            <div class="muted">${r.rinde>0 ? "Rinde "+r.rinde+" galletas" : "Sin definir cuántas galletas rinde"}</div>
          </div>
          <div class="item-actions">
            <button class="small secondary" data-renombrar="${r.id}">Editar</button>
            <button class="small danger" data-delrec="${r.id}">Eliminar receta</button>
          </div>
        </div>
        <ul class="recipe-items">
          ${cr.items.length===0 ? '<li class="muted">Sin productos agregados</li>' :
            cr.items.map(({it,c},i)=>{
              const prod = buscarProducto(it);
              const q = leerCantidad(it, prod);
              const cant = isNaN(q.num) ? it.quantity : numero(q.num);
              return `
              <li>
                <span>${escapeHtml(prod ? prod.name : it.productName)} — ${escapeHtml(String(cant))} ${escapeHtml(q.unit)}
                  <div class="muted">${c.ok ? dinero(c.costo) : '<span class="warn">⚠ '+escapeHtml(c.motivo)+'</span>'}</div>
                </span>
                <span>
                  <button class="small secondary" data-edititem="${r.id}|${i}">Editar</button>
                  <button class="small danger" data-delitem="${r.id}|${i}">✕</button>
                </span>
              </li>`;}).join("")}
        </ul>
        <div class="summary">
          <div>Costo total de la receta: <b>${dinero(cr.total)}</b></div>
          <div>${r.rinde>0 ? "Costo por galleta: <b>"+dinero(cr.total/r.rinde)+"</b>" : "Define cuántas galletas rinde (botón Editar) para ver el costo por galleta."}</div>
          ${cr.fallos ? `<div class="warn">⚠ ${cr.fallos} ingrediente(s) sin calcular, no están en el total.</div>` : ""}
        </div>
        <div class="form-row">
          <select data-productselect="${r.id}">
            <option value="">Selecciona un producto</option>
            ${productos.map(p=>`<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("")}
          </select>
          <input type="number" step="any" min="0" inputmode="decimal" placeholder="Cantidad" data-cantidad-input="${r.id}" style="max-width:110px">
          <select data-unidad-select="${r.id}" style="max-width:130px">${opcionesUnidad("")}</select>
          <button class="small" data-agregaritem="${r.id}">Agregar</button>
        </div>
      </div>`;}).join("");

    // al elegir un producto, se sugiere su unidad
    cont.querySelectorAll("[data-productselect]").forEach(s=>{
      s.addEventListener("change", ()=>{
        const p = productos.find(x=>x.id===s.value);
        cont.querySelector(`[data-unidad-select="${s.dataset.productselect}"]`).value = p ? (p.unit||"") : "";
      });
    });
    cont.querySelectorAll("[data-delrec]").forEach(b=>{
      b.addEventListener("click", ()=>{
        const r = recetas.find(x=>x.id===b.dataset.delrec);
        confirmarAccion(`¿Eliminar la receta "${r.name}" completa?`, "Eliminar", async ()=>{
          try{ await deleteDoc(doc(db, "recetas", r.id)); }
          catch(e){ console.error(e); alert("No se pudo eliminar la receta."); }
        });
      });
    });
    cont.querySelectorAll("[data-renombrar]").forEach(b=>{
      b.addEventListener("click", ()=> abrirModalEditarReceta(b.dataset.renombrar));
    });
    cont.querySelectorAll("[data-agregaritem]").forEach(b=>{
      b.addEventListener("click", async ()=>{
        const recId = b.dataset.agregaritem;
        const prodId = cont.querySelector(`[data-productselect="${recId}"]`).value;
        const cantidad = parseFloat(cont.querySelector(`[data-cantidad-input="${recId}"]`).value);
        const unit = cont.querySelector(`[data-unidad-select="${recId}"]`).value;
        if(!prodId){ alert("Selecciona un producto."); return; }
        if(!(cantidad>0)){ alert("Escribe una cantidad mayor a 0."); return; }
        if(!unit){ alert("Elige la unidad."); return; }
        const prod = productos.find(p=>p.id===prodId);
        const r = recetas.find(x=>x.id===recId);
        const nuevosItems = [...r.items, { productId: prod.id, productName: prod.name, quantity: cantidad, unit }];
        try{ await updateDoc(doc(db, "recetas", recId), { items: nuevosItems }); }
        catch(e){ console.error(e); alert("No se pudo agregar el ingrediente."); }
      });
    });
    cont.querySelectorAll("[data-delitem]").forEach(b=>{
      b.addEventListener("click", ()=>{
        const [recId, idx] = b.dataset.delitem.split("|");
        const r = recetas.find(x=>x.id===recId);
        const item = r.items[Number(idx)];
        const prod = buscarProducto(item);
        confirmarAccion(`¿Quitar "${prod ? prod.name : item.productName}" de la receta?`, "Quitar", async ()=>{
          const nuevosItems = r.items.filter((_,i)=> i !== Number(idx));
          try{ await updateDoc(doc(db, "recetas", recId), { items: nuevosItems }); }
          catch(e){ console.error(e); alert("No se pudo eliminar el ingrediente."); }
        });
      });
    });
    cont.querySelectorAll("[data-edititem]").forEach(b=>{
      b.addEventListener("click", ()=>{
        const [recId, idx] = b.dataset.edititem.split("|");
        abrirModalEditarItem(recId, Number(idx));
      });
    });
  }

  function abrirModalEditarReceta(recId){
    const r = recetas.find(x=>x.id===recId);
    if(!r) return;
    abrirModal(`
      <h3>Editar receta</h3>
      <div class="form-row"><input id="m-rec-nombre" placeholder="Nombre de la receta"></div>
      <div class="form-row"><input id="m-rec-rinde" type="number" min="1" step="1" inputmode="numeric" placeholder="Galletas que rinde"></div>
      <div class="modal-actions">
        <button class="secondary" id="modal-cancelar">Cancelar</button>
        <button id="modal-guardar">Guardar</button>
      </div>
    `);
    document.getElementById("m-rec-nombre").value = r.name;
    document.getElementById("m-rec-rinde").value = r.rinde || "";
    document.getElementById("modal-cancelar").addEventListener("click", cerrarModal);
    document.getElementById("modal-guardar").addEventListener("click", async ()=>{
      const nuevo = document.getElementById("m-rec-nombre").value.trim();
      if(!nuevo){ alert("Escribe un nombre."); return; }
      try{
        await updateDoc(doc(db, "recetas", recId), {
          name: nuevo, rinde: parseInt(document.getElementById("m-rec-rinde").value)||0
        });
        cerrarModal();
      }catch(e){
        console.error(e);
        alert("No se pudo guardar la receta.");
      }
    });
  }

  function abrirModalEditarItem(recId, idx){
    const r = recetas.find(x=>x.id===recId);
    if(!r) return;
    const item = r.items[idx];
    if(!item) return;
    const prod = buscarProducto(item);
    const q = leerCantidad(item, prod);
    abrirModal(`
      <h3>Editar ingrediente</h3>
      <p class="muted">${escapeHtml(prod ? prod.name : item.productName)}</p>
      <div class="form-row">
        <input id="m-item-cantidad" type="number" step="any" min="0" inputmode="decimal" placeholder="Cantidad">
        <select id="m-item-unidad"></select>
      </div>
      <div class="modal-actions">
        <button class="secondary" id="modal-cancelar">Cancelar</button>
        <button id="modal-guardar">Guardar</button>
      </div>
    `);
    document.getElementById("m-item-cantidad").value = isNaN(q.num) ? "" : q.num;
    document.getElementById("m-item-unidad").innerHTML = opcionesUnidad(q.unit);
    document.getElementById("modal-cancelar").addEventListener("click", cerrarModal);
    document.getElementById("modal-guardar").addEventListener("click", async ()=>{
      const cantidad = parseFloat(document.getElementById("m-item-cantidad").value);
      const unit = document.getElementById("m-item-unidad").value;
      if(!(cantidad>0)){ alert("Escribe una cantidad mayor a 0."); return; }
      if(!unit){ alert("Elige la unidad."); return; }
      const nuevosItems = r.items.map((it,i)=> i===idx
        ? { ...it, productId: prod ? prod.id : it.productId, quantity: cantidad, unit } : it);
      try{
        await updateDoc(doc(db, "recetas", recId), { items: nuevosItems });
        cerrarModal();
      }catch(e){
        console.error(e);
        alert("No se pudo editar el ingrediente.");
      }
    });
  }

  // ---- Calcular: gasto en materiales según receta y número de galletas ----
  elCReceta.addEventListener("change", renderCalcular);
  elCGalletas.addEventListener("input", renderCalcular);

  function renderCalcular(){
    const prev = elCReceta.value;
    elCReceta.innerHTML = '<option value="">Elige una receta</option>' +
      recetas.map(r=>`<option value="${r.id}">${escapeHtml(r.name)}</option>`).join("");
    if(recetas.some(r=>r.id===prev)) elCReceta.value = prev;

    const cont = document.getElementById("c-resultado");
    const r = recetas.find(x=>x.id===elCReceta.value);
    const n = parseInt(elCGalletas.value);
    if(!r || !(n>0)){
      cont.innerHTML = '<div class="empty">Elige una receta y cuántas galletas quieres hacer.</div>';
      return;
    }
    if(!(r.rinde>0)){
      cont.innerHTML = '<div class="empty">Esta receta no tiene definido cuántas galletas rinde. Defínelo en la pestaña Recetas (botón Editar).</div>';
      return;
    }
    const factor = n / r.rinde;
    const cr = costoReceta(r);
    const total = cr.total * factor;
    cont.innerHTML = `
      <div class="card">
        <div class="total-box">
          <div class="muted">Gasto estimado en materiales</div>
          <div class="big">${dinero(total)}</div>
          <div class="muted">${numero(n)} galletas · ${dinero(total/n)} por galleta</div>
        </div>
        <div class="muted" style="margin:10px 0 4px">Equivale a ${numero(factor)} vez/veces la receta (rinde ${r.rinde}). Necesitas:</div>
        <ul class="recipe-items">
          ${cr.items.map(({it,c})=>`
            <li>
              <span>${escapeHtml(c.ok ? c.nombre : (it.productName||""))} — ${c.ok ? cantidadBonita(c.base*factor, c.dim) : "?"}</span>
              <span>${c.ok ? dinero(c.costo*factor) : '<span class="warn">⚠ '+escapeHtml(c.motivo)+'</span>'}</span>
            </li>`).join("") || '<li class="muted">La receta no tiene ingredientes.</li>'}
        </ul>
        ${cr.fallos ? `<div class="warn">⚠ ${cr.fallos} ingrediente(s) no se pudieron calcular y no están en el total.</div>` : ""}
      </div>`;
  }

  function escapeHtml(str){
    return String(str).replace(/[&<>"']/g, s=>({
      "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
    }[s]));
  }
})();
