/*
 * Online shop, C4 container level.
 * Paste this into fasdraw (or open it with Space o) to get the diagram laid out.
 */
workspace "Shop" "Online shop" {

    model {
        customer = person "Customer" "Browses and buys products"
        staff = person "Back-office staff" "Manages catalogue and orders"
        email = softwareSystem "Email provider" "Delivers transactional email" "External"

        shop = softwareSystem "Shop" "Lets customers browse and buy" {
            web = container "Storefront" "Browse, cart and checkout" "React" "Web Browser"
            backoffice = container "Back office" "Catalogue and order admin" "Vue" "Web Browser"
            api = container "API" "Orders, catalogue and checkout" "Go"
            db = container "Orders DB" "Orders and catalogue" "PostgreSQL" "Database"
            events = container "Order events" "Order lifecycle" "Kafka" "Queue"
            mailer = container "Mailer" "Sends order emails" "Node.js"
        }

        customer -> web "Shops using" "HTTPS"
        staff -> backoffice "Manages orders using" "HTTPS"
        web -> api "Calls" "JSON/HTTPS"
        backoffice -> api "Calls" "JSON/HTTPS"
        api -> db "Reads and writes" "SQL"
        api -> events "Publishes" "Kafka" "Async"
        events -> mailer "Delivers to" "Kafka" "Async"
        mailer -> email "Sends emails using" "SMTP"
    }

    views {
        container shop "containers" {
            include *
            autolayout lr
        }

        styles {
            element "Database" {
                shape cylinder
            }
            element "Queue" {
                shape pipe
            }
            element "Web Browser" {
                shape webbrowser
            }
            element "External" {
                background #7d7d7d
            }
            relationship "Async" {
                style dashed
            }
        }
    }
}
