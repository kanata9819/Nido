use super::*;

pub(super) fn diff(source: &str) -> AnyElement {
    let mut list = column().gap_0().font_family("Consolas").text_size(px(12.));
    for line in source.lines() {
        let color = if line.starts_with('+') {
            0x99c68c
        } else if line.starts_with('-') {
            0xe59b96
        } else if line.starts_with('@') {
            0x80b9d9
        } else {
            0xa8b2bc
        };
        list = list.child(div().whitespace_normal().text_color(rgb(color)).child(
            if line.is_empty() {
                " ".into()
            } else {
                line.to_owned()
            },
        ));
    }
    list.into_any_element()
}
pub(super) fn markdown(source: &str) -> AnyElement {
    use pulldown_cmark::{Event as Md, Tag, TagEnd};
    let mut list = column();
    let mut text = String::new();
    let mut heading = false;
    let mut code = false;
    for event in pulldown_cmark::Parser::new_ext(
        source,
        pulldown_cmark::Options::ENABLE_TABLES | pulldown_cmark::Options::ENABLE_STRIKETHROUGH,
    ) {
        match event {
            Md::Start(Tag::Heading { .. }) => heading = true,
            Md::Start(Tag::CodeBlock(_)) => code = true,
            Md::Text(t) | Md::Code(t) => text.push_str(&t),
            Md::SoftBreak | Md::HardBreak => text.push('\n'),
            Md::End(
                TagEnd::Paragraph
                | TagEnd::Heading(_)
                | TagEnd::CodeBlock
                | TagEnd::Item
                | TagEnd::TableRow,
            ) => {
                if !text.is_empty() {
                    list = list.child(
                        div()
                            .whitespace_normal()
                            .when(heading, |el| {
                                el.font_weight(FontWeight::SEMIBOLD).text_size(px(20.))
                            })
                            .when(code, |el| {
                                el.font_family("Consolas").p_2().bg(rgb(0x12181e))
                            })
                            .child(std::mem::take(&mut text)),
                    );
                }
                heading = false;
                code = false;
            }
            _ => {}
        }
    }
    if !text.is_empty() {
        list = list.child(text);
    }
    list.into_any_element()
}
