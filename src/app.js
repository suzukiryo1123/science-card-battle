async function loadCards() {
  const grid = document.getElementById('card-grid');
  const tpl = document.getElementById('card-tpl');

  try {
    const res = await fetch('data/cards.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    /** @type {{rarity:string,name:string,type:string,hp:number,phy:number,che:number,bio:number,image:string}[]} */
    const cards = await res.json();

    // ひとまず SR だけ表示（data/cards.json に入っている分）
    cards.forEach(card => {
      const frag = tpl.content.cloneNode(true);

      const img = frag.querySelector('.card-img');
      img.src = card.image;
      img.alt = `${card.name} のカード`;

      frag.querySelector('.rarity').textContent = card.rarity;
      frag.querySelector('.type').textContent   = card.type;
      frag.querySelector('.name').textContent   = card.name;

      frag.querySelector('.hp').textContent  = card.hp;
      frag.querySelector('.phy').textContent = card.phy;
      frag.querySelector('.che').textContent = card.che;
      frag.querySelector('.bio').textContent = card.bio;

      grid.appendChild(frag);
    });
  } catch (err) {
    grid.innerHTML = `<p>カードの読み込みに失敗しました：${String(err)}</p>`;
    console.error(err);
  }
}

loadCards();
