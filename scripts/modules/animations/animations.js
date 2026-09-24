function animatePageEnter(pageElement) {
    pageElement.style.opacity = '0';
    pageElement.style.transform = 'translateY(20px)';
    requestAnimationFrame(() => {
        pageElement.style.transition = 'opacity 0.4s cubic-bezier(0.16, 1, 0.3, 1), transform 0.4s cubic-bezier(0.16, 1, 0.3, 1)';
        pageElement.style.opacity = '1';
        pageElement.style.transform = 'translateY(0)';
    });
}

function animateCardsIn(container) {
    const cards = container.querySelectorAll('.class-card, .status-card, .holiday-card');
    cards.forEach((card, index) => {
        card.style.opacity = '0';
        card.style.transform = 'translateY(15px)';
        setTimeout(() => {
            card.style.transition = 'opacity 0.35s ease, transform 0.35s cubic-bezier(0.16, 1, 0.3, 1)';
            card.style.opacity = '1';
            card.style.transform = 'translateY(0)';
        }, index * 60);
    });
}