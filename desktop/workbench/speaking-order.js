(() => {
  window.createSpeakingOrder = (container,{roles,selected=[],change=()=>{}}) => {
    let ids=[];const available=new Map(roles.map(role=>[role.id,role]));container.classList.add('speaking-order-list');
    function render(){
      container.replaceChildren();
      for(const [index,id] of ids.entries()){
        const row=document.createElement('div');row.className='group-order-row';
        const label=document.createElement('span');label.textContent=(index+1)+'. '+available.get(id).name;row.append(label);
        for(const [delta,text] of [[-1,'上移'],[1,'下移']]){
          const button=document.createElement('button');button.type='button';button.textContent=text;button.dataset.orderMove=String(delta);button.dataset.orderIndex=String(index);button.disabled=index+delta<0||index+delta>=ids.length;
          button.setAttribute('aria-label',text+' '+available.get(id).name);
          button.onclick=()=>{[ids[index],ids[index+delta]]=[ids[index+delta],ids[index]];render();change([...ids]);};row.append(button);
        }
        container.append(row);
      }
    }
    function set(selected){ids=[...new Set(selected)].filter(id=>available.has(id));render();}
    set(selected);return{set,selected:()=>[...ids]};
  };
})();
